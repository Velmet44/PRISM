/**
 * Stage 2 basic scheduler (PRISM V1 §26.3, §27.5, §58.2).
 *
 * An in-memory FIFO admission queue over Run attempts. `admit()` dequeues the
 * head only when the (stubbed) resource check passes; otherwise it returns
 * `null` and the head keeps its place (head-of-line blocking, documented for
 * the Stage 2 single-pool setup). Runs that entered `WAITING_*`/`SLEEPING`/
 * `PAUSED` already released their reservations, so `requeue()` returns them
 * to `QUEUED` for re-admission without teardown. Run state transitions
 * themselves belong to `RunManager`; the scheduler validates the caller's
 * reported Run state against `REQUEUEABLE_RUN_STATES` before requeueing.
 */

import type { ErrorCode } from "@prism/schemas";
import { REQUEUEABLE_RUN_STATES } from "../runs/index.js";

export interface ResourceRequirements {
  cpuMillicores?: number;
  memoryMb?: number;
  gpuCount?: number;
}

export interface ResourceChecker {
  canAdmit(requirements: ResourceRequirements): boolean;
}

export interface AccountingResources extends ResourceChecker {
  acquire(requirements: ResourceRequirements): boolean;
  release(requirements: ResourceRequirements): void;
}

/** Default stub: no real pool yet, everything fits. */
export class AllowAllResources implements ResourceChecker {
  canAdmit(_requirements: ResourceRequirements): boolean {
    return true;
  }
}

/**
 * Bounded stub pool for tests and single-node accounting. Tracks admitted
 * usage against a fixed capacity; `acquire`/`release` are driven by the
 * scheduler. This is honest best-effort accounting, not enforcement.
 */
export class BoundedResources implements AccountingResources {
  private usedCpu = 0;
  private usedMemoryMb = 0;
  private usedGpu = 0;

  constructor(
    private readonly capacity: Required<ResourceRequirements>,
  ) {}

  canAdmit(requirements: ResourceRequirements): boolean {
    return (
      this.usedCpu + (requirements.cpuMillicores ?? 0) <=
        this.capacity.cpuMillicores &&
      this.usedMemoryMb + (requirements.memoryMb ?? 0) <=
        this.capacity.memoryMb &&
      this.usedGpu + (requirements.gpuCount ?? 0) <= this.capacity.gpuCount
    );
  }

  acquire(requirements: ResourceRequirements): boolean {
    if (!this.canAdmit(requirements)) return false;
    this.usedCpu += requirements.cpuMillicores ?? 0;
    this.usedMemoryMb += requirements.memoryMb ?? 0;
    this.usedGpu += requirements.gpuCount ?? 0;
    return true;
  }

  release(requirements: ResourceRequirements): void {
    this.usedCpu = Math.max(0, this.usedCpu - (requirements.cpuMillicores ?? 0));
    this.usedMemoryMb = Math.max(
      0,
      this.usedMemoryMb - (requirements.memoryMb ?? 0),
    );
    this.usedGpu = Math.max(0, this.usedGpu - (requirements.gpuCount ?? 0));
  }

  usage(): Required<ResourceRequirements> {
    return {
      cpuMillicores: this.usedCpu,
      memoryMb: this.usedMemoryMb,
      gpuCount: this.usedGpu,
    };
  }
}

export interface QueuedEntry {
  runId: string;
  requirements: ResourceRequirements;
  admitted: boolean;
  enqueuedAt: number;
}

export interface Admission {
  runId: string;
  admittedAt: number;
}

export interface SchedulerOptions {
  resources?: ResourceChecker;
  now?: () => number;
}

export class SchedulerError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "SchedulerError";
    this.code = code;
  }
}

function isAccounting(
  checker: ResourceChecker,
): checker is AccountingResources {
  return (
    "acquire" in checker &&
    typeof (checker as AccountingResources).acquire === "function" &&
    "release" in checker &&
    typeof (checker as AccountingResources).release === "function"
  );
}

export class BasicScheduler {
  private readonly entries = new Map<string, QueuedEntry>();
  private readonly order: string[] = [];
  private readonly resources: ResourceChecker;
  private readonly now: () => number;

  constructor(opts: SchedulerOptions = {}) {
    this.resources = opts.resources ?? new AllowAllResources();
    this.now = opts.now ?? Date.now;
  }

  /**
   * Enqueue a Run attempt for admission. Idempotent: re-enqueueing a Run
   * that is already queued returns the existing entry.
   */
  enqueue(runId: string, requirements: ResourceRequirements = {}): QueuedEntry {
    if (runId.length === 0) {
      throw new SchedulerError("INVALID_ARGUMENT", "runId is required");
    }
    const existing = this.entries.get(runId);
    if (existing !== undefined) {
      return { ...existing, requirements: { ...existing.requirements } };
    }
    const entry: QueuedEntry = {
      runId,
      requirements: { ...requirements },
      admitted: false,
      enqueuedAt: this.now(),
    };
    this.entries.set(runId, entry);
    this.order.push(runId);
    return { ...entry, requirements: { ...entry.requirements } };
  }

  peek(): QueuedEntry | null {
    for (const runId of this.order) {
      const entry = this.entries.get(runId);
      if (entry !== undefined && !entry.admitted) {
        return { ...entry, requirements: { ...entry.requirements } };
      }
    }
    return null;
  }

  /**
   * Admit the head of the queue when the resource check passes. Returns
   * `null` when the queue is empty or the head does not fit (the head keeps
   * its place; later entries are not skipped past it).
   */
  admit(): Admission | null {
    const head = this.peek();
    if (head === null) return null;
    if (!this.resources.canAdmit(head.requirements)) return null;
    const entry = this.entries.get(head.runId);
    if (entry === undefined || entry.admitted) return null;
    const checker = this.resources;
    if (isAccounting(checker) && !checker.acquire(entry.requirements)) {
      return null;
    }
    entry.admitted = true;
    return { runId: entry.runId, admittedAt: this.now() };
  }

  /**
   * Release a Run's queue slot (terminal state, cancellation, or explicit
   * dequeue), returning its accounted resources. Returns false when unknown.
   */
  release(runId: string): boolean {
    const entry = this.entries.get(runId);
    if (entry === undefined) return false;
    const checker = this.resources;
    if (entry.admitted && isAccounting(checker)) {
      checker.release(entry.requirements);
    }
    this.entries.delete(runId);
    const at = this.order.indexOf(runId);
    if (at >= 0) this.order.splice(at, 1);
    return true;
  }

  /**
   * Return a Run to `QUEUED` for re-admission after `WAITING_*`/`SLEEPING`/
   * `PAUSED` (reservations were already released, so no teardown is needed).
   * The caller reports the Run's current state; anything outside
   * `REQUEUEABLE_RUN_STATES` throws. Unknown queue slots are re-added so a
   * scheduler restart cannot strand a waiting Run.
   */
  requeue(
    runId: string,
    currentRunState: string,
    requirements: ResourceRequirements = {},
  ): QueuedEntry {
    if (!REQUEUEABLE_RUN_STATES.includes(currentRunState)) {
      throw new SchedulerError(
        "INVALID_ARGUMENT",
        `requeue requires a waiting state (run is ${currentRunState})`,
      );
    }
    const existing = this.entries.get(runId);
    if (existing !== undefined) {
      const checker = this.resources;
      if (existing.admitted && isAccounting(checker)) {
        checker.release(existing.requirements);
      }
      existing.admitted = false;
      existing.requirements = { ...requirements };
      existing.enqueuedAt = this.now();
      const at = this.order.indexOf(runId);
      if (at >= 0) this.order.splice(at, 1);
      this.order.push(runId);
      return { ...existing, requirements: { ...existing.requirements } };
    }
    return this.enqueue(runId, requirements);
  }

  isAdmitted(runId: string): boolean {
    return this.entries.get(runId)?.admitted ?? false;
  }

  size(): number {
    return this.entries.size;
  }

  pendingCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!entry.admitted) count += 1;
    }
    return count;
  }

  list(): QueuedEntry[] {
    const out: QueuedEntry[] = [];
    for (const runId of this.order) {
      const entry = this.entries.get(runId);
      if (entry !== undefined) {
        out.push({ ...entry, requirements: { ...entry.requirements } });
      }
    }
    return out;
  }
}
