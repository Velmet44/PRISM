/**
 * Stage 2 basic Resource Pool — admission accounting with honest labels.
 *
 * Spec: §9 (configurable pool: CPU/RAM/storage/network/GPU; host headroom
 * so PRISM cannot starve the host), §9.2 (GPU allocation is best-effort
 * unless the runtime enforces isolation — PRISM must expose that limitation
 * rather than claim hard quotas; estimated VRAM may reserve + queue),
 * §9.3 (every dimension exposed via
 * `ResourceCapacity{limit,enforcement: hard|best-effort|accounting-only}`
 * rendered verbatim in the UI; admission is the intersection of sandbox
 * resources, inference capacity, and network policy; Ollama
 * concurrency/load limits respected), §53.2-5 (waiting/paused/recovery
 * states release reclaimable execution resources — the scheduler does that
 * by calling `releaseRun()`).
 *
 * This module performs admission-time accounting only. It never claims
 * OS-level enforcement it does not have: dimensions the Node cannot fence
 * are labelled `best-effort`/`accounting-only` verbatim for the UI.
 */

import type { ErrorCode } from "@prism/schemas";

// ---------------------------------------------------------------------------
// Errors (§58.5)
// ---------------------------------------------------------------------------

export class ResourceError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ResourceError";
    this.code = code;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// Capacity model (§9.3, §53 invariant 53)
// ---------------------------------------------------------------------------

export type Enforcement = "hard" | "best-effort" | "accounting-only";

export interface ResourceCapacity {
  limit: number;
  unit: string;
  enforcement: Enforcement;
  /** Honest limitation note, rendered verbatim alongside the label. */
  note: string;
}

export type ResourceDimension =
  | "cpu"
  | "ram"
  | "storage"
  | "gpuVram"
  | "modelConcurrency"
  | "modelSlots"
  | "network";

export interface ResourcePoolConfig {
  /** Total CPU cores allocated to PRISM (§9). */
  cpuCores: number;
  /** Total RAM (MiB) allocated to PRISM. */
  ramMB: number;
  /** Total persistent storage (MiB) allocated to PRISM. */
  storageMB: number;
  /** GPU VRAM (MiB) visible to the runtime; 0/absent = no GPU. */
  gpuVramMB?: number;
  /** Ollama concurrency/load limit respected at admission (§9.3). */
  maxConcurrentModels?: number;
  /** Loaded-model slots (models may unload + reload under pressure). */
  modelSlots?: number;
  /**
   * Explicit owner headroom overrides. Defaults reserve
   * `max(10%, 2GB RAM + 1 core)`; an explicit `0` keeps 0 with a warning.
   */
  headroomCpuCores?: number;
  headroomRamMB?: number;
  /** Platform-measured enforcement strengths; unknown layers stay honest. */
  enforcement?: Partial<Record<ResourceDimension, Enforcement>>;
}

export interface ResourceRequirements {
  cpuCores?: number;
  ramMB?: number;
  storageMB?: number;
  /** Estimated VRAM (MiB). Best-effort: reserves + queues, never hard-fences. */
  gpuVramMB?: number;
  /** Loaded-model slots needed (default 0 = no resident model). */
  modelSlots?: number;
  /** True when the Run performs model inference (concurrency slot). */
  needsInference?: boolean;
}

export interface Reservation {
  runId: string;
  cpuCores: number;
  ramMB: number;
  storageMB: number;
  gpuVramMB: number;
  modelSlots: number;
  inferenceSlots: number;
}

export type AdmissionDecisionKind = "admit" | "queue" | "reject";

export interface AdmissionDecision {
  decision: AdmissionDecisionKind;
  runId: string;
  /** Machine-readable cause (RESOURCE_UNAVAILABLE / QUOTA_EXCEEDED / ...). */
  code: ErrorCode | null;
  reason: string;
  /** Verbatim per-dimension capacities for the UI (§9.3). */
  capacities: Record<ResourceDimension, ResourceCapacity>;
  /** True when GPU was granted best-effort (no enforceable isolation). */
  gpuBestEffort: boolean;
  warnings: string[];
}

export interface PoolUsage {
  reserved: ReservationTotals;
  available: ReservationTotals;
  headroom: { cpuCores: number; ramMB: number };
  activeRuns: number;
}

export interface ReservationTotals {
  cpuCores: number;
  ramMB: number;
  storageMB: number;
  gpuVramMB: number;
  modelSlots: number;
  inferenceSlots: number;
}

const DEFAULT_MAX_CONCURRENT_MODELS = 2;
const DEFAULT_MODEL_SLOTS = 2;
const HEADROOM_RAM_FLOOR_MB = 2048;
const HEADROOM_CPU_FLOOR = 1;

function requireNonNegative(name: string, value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new ResourceError("INVALID_ARGUMENT", `${name} must be >= 0`);
  }
  return value;
}

export class ResourcePool {
  private readonly totalCpu: number;
  private readonly totalRamMB: number;
  private readonly totalStorageMB: number;
  private readonly totalGpuVramMB: number;
  private readonly maxConcurrentModels: number;
  private readonly totalModelSlots: number;
  private readonly headroomCpu: number;
  private readonly headroomRamMB: number;
  private readonly enforcement: Record<ResourceDimension, Enforcement>;
  private readonly reservations = new Map<string, Reservation>();
  private readonly headroomWarnings: string[];

  constructor(config: ResourcePoolConfig) {
    this.totalCpu = requireNonNegative("cpuCores", config.cpuCores);
    this.totalRamMB = requireNonNegative("ramMB", config.ramMB);
    this.totalStorageMB = requireNonNegative("storageMB", config.storageMB);
    this.totalGpuVramMB = requireNonNegative("gpuVramMB", config.gpuVramMB);
    this.maxConcurrentModels =
      config.maxConcurrentModels ?? DEFAULT_MAX_CONCURRENT_MODELS;
    this.totalModelSlots = config.modelSlots ?? DEFAULT_MODEL_SLOTS;
    if (!Number.isInteger(this.maxConcurrentModels) || this.maxConcurrentModels < 1) {
      throw new ResourceError(
        "INVALID_ARGUMENT",
        "maxConcurrentModels must be an integer >= 1",
      );
    }
    if (!Number.isInteger(this.totalModelSlots) || this.totalModelSlots < 1) {
      throw new ResourceError("INVALID_ARGUMENT", "modelSlots must be an integer >= 1");
    }

    // Host headroom: max(10%, 2GB RAM + 1 core) unless the owner explicitly
    // sets 0 — which is kept, with a warning, per §9.
    const warnings: string[] = [];
    if (config.headroomCpuCores !== undefined) {
      if (config.headroomCpuCores < 0) {
        throw new ResourceError("INVALID_ARGUMENT", "headroomCpuCores must be >= 0");
      }
      this.headroomCpu = config.headroomCpuCores;
      if (config.headroomCpuCores === 0) {
        warnings.push("CPU headroom explicitly set to 0: PRISM may starve the host");
      }
    } else {
      this.headroomCpu = Math.max(this.totalCpu * 0.1, HEADROOM_CPU_FLOOR);
    }
    if (config.headroomRamMB !== undefined) {
      if (config.headroomRamMB < 0) {
        throw new ResourceError("INVALID_ARGUMENT", "headroomRamMB must be >= 0");
      }
      this.headroomRamMB = config.headroomRamMB;
      if (config.headroomRamMB === 0) {
        warnings.push("RAM headroom explicitly set to 0: PRISM may starve the host");
      }
    } else {
      this.headroomRamMB = Math.max(this.totalRamMB * 0.1, HEADROOM_RAM_FLOOR_MB);
    }
    this.headroomWarnings = warnings;

    // Honest defaults: only admission counters we control are `hard`. CPU/RAM
    // are best-effort without OS quota enforcement; GPU VRAM is best-effort
    // because the runtime cannot fence per-Agent VRAM (§9.2); network is
    // accounting-only until the egress proxy meters it (Stage 5).
    this.enforcement = {
      cpu: config.enforcement?.cpu ?? "best-effort",
      ram: config.enforcement?.ram ?? "best-effort",
      storage: config.enforcement?.storage ?? "hard",
      gpuVram: config.enforcement?.gpuVram ?? "best-effort",
      modelConcurrency: config.enforcement?.modelConcurrency ?? "hard",
      modelSlots: config.enforcement?.modelSlots ?? "hard",
      network: config.enforcement?.network ?? "accounting-only",
    };
  }

  /** Per-dimension capacities, rendered verbatim in the UI (§9.3). */
  capacities(): Record<ResourceDimension, ResourceCapacity> {
    return {
      cpu: {
        limit: this.totalCpu,
        unit: "cores",
        enforcement: this.enforcement.cpu,
        note:
          this.enforcement.cpu === "hard"
            ? "enforced at the platform layer"
            : "admission accounting only; no OS quota fence claimed",
      },
      ram: {
        limit: this.totalRamMB,
        unit: "MiB",
        enforcement: this.enforcement.ram,
        note:
          this.enforcement.ram === "hard"
            ? "enforced at the platform layer"
            : "reservation/limit accounting; overcommit is queued, not fenced",
      },
      storage: {
        limit: this.totalStorageMB,
        unit: "MiB",
        enforcement: this.enforcement.storage,
        note: "quota checked at admission; runtime growth is accounted, not preemptively fenced",
      },
      gpuVram: {
        limit: this.totalGpuVramMB,
        unit: "MiB",
        enforcement: this.enforcement.gpuVram,
        note:
          "best-effort: the runtime provides no enforceable per-Agent VRAM isolation; estimates reserve capacity and queue work (§9.2)",
      },
      modelConcurrency: {
        limit: this.maxConcurrentModels,
        unit: "requests",
        enforcement: this.enforcement.modelConcurrency,
        note: "Ollama concurrency/load limits respected at admission",
      },
      modelSlots: {
        limit: this.totalModelSlots,
        unit: "slots",
        enforcement: this.enforcement.modelSlots,
        note: "loaded-model residency; models unload/reload under pressure",
      },
      network: {
        limit: 0,
        unit: "policy",
        enforcement: this.enforcement.network,
        note: "accounting-only until run-bound egress metering lands",
      },
    };
  }

  /**
   * Admission = intersection of sandbox resources, inference capacity, and
   * (accounted) network policy. Admits when everything fits inside the
   * headroom-adjusted pool; queues when a releasable dimension is full
   * (CPU/RAM/GPU estimate/model slot); rejects only on hard-quota breach
   * (storage). Never claims resources it does not have.
   */
  admitRun(runId: string, req: ResourceRequirements = {}): AdmissionDecision {
    if (runId.length === 0) {
      throw new ResourceError("INVALID_ARGUMENT", "runId required");
    }
    if (this.reservations.has(runId)) {
      throw new ResourceError("CONFLICT", `run ${runId} already admitted`);
    }
    const need: Reservation = {
      runId,
      cpuCores: requireNonNegative("cpuCores", req.cpuCores),
      ramMB: requireNonNegative("ramMB", req.ramMB),
      storageMB: requireNonNegative("storageMB", req.storageMB),
      gpuVramMB: requireNonNegative("gpuVramMB", req.gpuVramMB),
      modelSlots: Math.trunc(requireNonNegative("modelSlots", req.modelSlots)),
      inferenceSlots: req.needsInference === true ? 1 : 0,
    };
    const capacities = this.capacities();
    const used = this.sumReservations();
    const warnings = [...this.headroomWarnings];
    let gpuBestEffort = false;

    const availCpu = this.totalCpu - this.headroomCpu - used.cpuCores;
    const availRam = this.totalRamMB - this.headroomRamMB - used.ramMB;
    const availStorage = this.totalStorageMB - used.storageMB;
    const availGpu = this.totalGpuVramMB - used.gpuVramMB;
    const availInference = this.maxConcurrentModels - used.inferenceSlots;
    const availSlots = this.totalModelSlots - used.modelSlots;

    if (need.storageMB > availStorage) {
      return {
        decision: "reject",
        runId,
        code: "QUOTA_EXCEEDED",
        reason: `storage quota exceeded: need ${need.storageMB}MiB, ${availStorage}MiB available`,
        capacities,
        gpuBestEffort: false,
        warnings,
      };
    }
    if (need.cpuCores > availCpu || need.ramMB > availRam) {
      return {
        decision: "queue",
        runId,
        code: "RESOURCE_UNAVAILABLE",
        reason:
          `insufficient execution resources: need ${need.cpuCores}cpu/` +
          `${need.ramMB}MiB, available ${availCpu}cpu/${availRam}MiB after headroom`,
        capacities,
        gpuBestEffort: false,
        warnings,
      };
    }
    if (need.inferenceSlots > availInference) {
      return {
        decision: "queue",
        runId,
        code: "RESOURCE_UNAVAILABLE",
        reason: `inference at Ollama concurrency limit (${this.maxConcurrentModels}); queued`,
        capacities,
        gpuBestEffort: false,
        warnings,
      };
    }
    if (need.modelSlots > availSlots) {
      return {
        decision: "queue",
        runId,
        code: "RESOURCE_UNAVAILABLE",
        reason: `no loaded-model slot free (${this.totalModelSlots} total); queued`,
        capacities,
        gpuBestEffort: false,
        warnings,
      };
    }
    if (need.gpuVramMB > 0 && need.gpuVramMB > availGpu) {
      // §9.2: reserve estimated VRAM and queue — never claim it fenced.
      return {
        decision: "queue",
        runId,
        code: "RESOURCE_UNAVAILABLE",
        reason:
          `estimated VRAM ${need.gpuVramMB}MiB exceeds available ${availGpu}MiB; ` +
          `queued (best-effort, no hard isolation claimed)`,
        capacities,
        gpuBestEffort: true,
        warnings,
      };
    }
    if (need.gpuVramMB > 0) {
      gpuBestEffort = true;
      warnings.push(
        "GPU granted best-effort: runtime oversubscription/failure is handled explicitly, not fenced",
      );
    }
    this.reservations.set(runId, need);
    return {
      decision: "admit",
      runId,
      code: null,
      reason: "admitted within headroom-adjusted pool",
      capacities,
      gpuBestEffort,
      warnings,
    };
  }

  /**
   * Release a Run's reservation. Waiting, paused, and recovery states
   * release reclaimable execution resources via this call (§53.2-5).
   * Idempotent: unknown runs return false.
   */
  releaseRun(runId: string): boolean {
    return this.reservations.delete(runId);
  }

  admittedRunIds(): string[] {
    return [...this.reservations.keys()];
  }

  usage(): PoolUsage {
    const reserved = this.sumReservations();
    return {
      reserved,
      available: {
        cpuCores: this.totalCpu - this.headroomCpu - reserved.cpuCores,
        ramMB: this.totalRamMB - this.headroomRamMB - reserved.ramMB,
        storageMB: this.totalStorageMB - reserved.storageMB,
        gpuVramMB: this.totalGpuVramMB - reserved.gpuVramMB,
        modelSlots: this.totalModelSlots - reserved.modelSlots,
        inferenceSlots: this.maxConcurrentModels - reserved.inferenceSlots,
      },
      headroom: { cpuCores: this.headroomCpu, ramMB: this.headroomRamMB },
      activeRuns: this.reservations.size,
    };
  }

  private sumReservations(): ReservationTotals {
    const total: ReservationTotals = {
      cpuCores: 0,
      ramMB: 0,
      storageMB: 0,
      gpuVramMB: 0,
      modelSlots: 0,
      inferenceSlots: 0,
    };
    for (const r of this.reservations.values()) {
      total.cpuCores += r.cpuCores;
      total.ramMB += r.ramMB;
      total.storageMB += r.storageMB;
      total.gpuVramMB += r.gpuVramMB;
      total.modelSlots += r.modelSlots;
      total.inferenceSlots += r.inferenceSlots;
    }
    return total;
  }
}
