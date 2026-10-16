/**
 * Stage 2 Model Manager — provider-family abstraction over local runtimes.
 *
 * Spec: §31 (Model Manager owns the model abstraction; Ollama is the V1
 * local runtime behind an adapter; Agents reference shared model IDs such as
 * `qwen3-30b`, never an Ollama-specific implementation name; weights are
 * shared at Node level, §31.3 / invariant 10), §53 invariants 17–18 (V1 uses
 * the Ollama adapter AND PRISM is not hardcoded to Ollama internally —
 * routing always goes through the family registry below), §30.1 (routing
 * precedence explicit > task-override > node-policy; the final
 * model/provider is recorded in run metadata), §58.2 (modelInstallation
 * state machine enforced via `canTransition`).
 *
 * Stage 2 scope: exactly one local family (`ollama`) plus exactly one auto
 * profile (`auto-balanced`). Any other family or profile is rejected with
 * `UNSUPPORTED` — BYOK provider families arrive in Stage 6.
 *
 * Transport: `fetch` against the Ollama HTTP API only (default
 * `http://localhost:11434`); no SDK, no native addons.
 */

import * as path from "node:path";
import { canTransition } from "@prism/schemas";
import type { ErrorCode } from "@prism/schemas";

// ---------------------------------------------------------------------------
// Errors (§58.5)
// ---------------------------------------------------------------------------

export class ModelManagerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly remediation?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; remediation?: string },
  ) {
    super(message);
    this.name = "ModelManagerError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    if (opts?.remediation !== undefined) this.remediation = opts.remediation;
  }
}

// ---------------------------------------------------------------------------
// Provider-family abstraction (invariant 18: nothing here names Ollama
// except the one adapter class + the default registration below)
// ---------------------------------------------------------------------------

/**
 * Adapter families known to the abstraction. Stage 2 admits `ollama` only;
 * the rest are declared so the rejection path stays explicit (§30, Stage 6).
 */
export type ProviderFamily =
  | "ollama"
  | "openai-compatible"
  | "anthropic"
  | "gemini";

export const STAGE2_FAMILIES: readonly ProviderFamily[] = ["ollama"] as const;

/** The single Stage 2 auto profile. No other profile exists yet. */
export const AUTO_PROFILE = "auto-balanced" as const;
export type AutoProfile = typeof AUTO_PROFILE;

/** Agent-facing catalog entry: a shared model ID, never a runtime name. */
export interface CatalogEntry {
  /** Agent-facing reference, e.g. `qwen3-30b`. */
  modelId: string;
  displayName: string;
  family: ProviderFamily;
  /** Runtime/installation ref kept out of Agent definitions (e.g. `qwen3:8b`). */
  runtimeRef: string;
  capabilities: string[];
  contextLength: number | null;
  sizeBytes: number;
}

export interface GenerateInput {
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface GenerateOutput {
  model: string;
  text: string;
  done: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatInput {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatOutput {
  model: string;
  message: ChatMessage;
  done: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ModelRuntimeAdapter {
  readonly family: ProviderFamily;
  readonly runtimeName: string;
  listModels(signal?: AbortSignal): Promise<CatalogEntry[]>;
  generate(input: GenerateInput): Promise<GenerateOutput>;
  chat(input: ChatInput): Promise<ChatOutput>;
}

// ---------------------------------------------------------------------------
// Ollama adapter (invariant 17: the V1 local inference runtime)
// ---------------------------------------------------------------------------

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;

interface OllamaTagDetails {
  parameter_size?: string;
  quantization_level?: string;
  family?: string;
}

interface OllamaTagModel {
  name?: string;
  model?: string;
  size?: number;
  digest?: string;
  details?: OllamaTagDetails;
}

function toCatalogEntry(raw: OllamaTagModel): CatalogEntry | null {
  const runtimeRef = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : null;
  if (runtimeRef === null) return null;
  // Agent-facing modelId drops the `:tag` suffix (`qwen3:8b` -> `qwen3`);
  // the full runtimeRef stays in the manager, never in Agent definitions.
  const sep = runtimeRef.indexOf(":");
  const base = sep < 0 ? runtimeRef : runtimeRef.slice(0, sep);
  const modelId = base.replace(/[^A-Za-z0-9._-]+/g, "-") || runtimeRef;
  const capabilities: string[] = [];
  const family = raw.details?.family;
  if (typeof family === "string" && family.length > 0) capabilities.push(`family:${family}`);
  if (raw.details?.parameter_size) capabilities.push(`params:${raw.details.parameter_size}`);
  return {
    modelId,
    displayName: base,
    family: "ollama",
    runtimeRef,
    capabilities,
    contextLength: null,
    sizeBytes: typeof raw.size === "number" ? raw.size : 0,
  };
}

export interface OllamaAdapterOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
}

export class OllamaAdapter implements ModelRuntimeAdapter {
  readonly family: ProviderFamily = "ollama";
  readonly runtimeName = "ollama";
  private baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly nowMs: () => number;

  constructor(opts?: OllamaAdapterOptions) {
    const base = opts?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    this.baseUrl = base.replace(/\/+$/, "");
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
    this.fetchFn = opts?.fetchFn ?? fetch;
    this.nowMs = opts?.nowMs ?? Date.now;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setBaseUrl(baseUrl: string): void {
    if (baseUrl.length === 0) throw new Error("OllamaAdapter: baseUrl required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(
    method: string,
    target: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchFn(`${this.baseUrl}${target}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelManagerError(
          "PROVIDER_UNAVAILABLE",
          `ollama ${method} ${target} failed with HTTP ${response.status}`,
          { retryable: response.status === 429 || response.status >= 500 },
        );
      }
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof ModelManagerError) throw err;
      const aborted =
        (signal?.aborted ?? false) || controller.signal.aborted;
      throw new ModelManagerError(
        "PROVIDER_UNAVAILABLE",
        aborted
          ? `ollama ${method} ${target} timed out after ${this.timeoutMs}ms`
          : `ollama unreachable at ${this.baseUrl}: ${(err as Error).message}`,
        { retryable: true, remediation: "verify the Ollama runtime is running" },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** GET /api/tags — installed local models. */
  async listModels(signal?: AbortSignal): Promise<CatalogEntry[]> {
    const data = await this.request<{ models?: OllamaTagModel[] }>(
      "GET",
      "/api/tags",
      undefined,
      signal,
    );
    const models = Array.isArray(data.models) ? data.models : [];
    const entries: CatalogEntry[] = [];
    for (const raw of models) {
      const entry = toCatalogEntry(raw);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  /** POST /api/generate — single-turn completion (stream:false). */
  async generate(input: GenerateInput): Promise<GenerateOutput> {
    if (input.model.length === 0) {
      throw new ModelManagerError("INVALID_ARGUMENT", "generate: model required");
    }
    const data = await this.request<{
      model?: string;
      response?: string;
      done?: boolean;
      prompt_eval_count?: number;
      eval_count?: number;
    }>("POST", "/api/generate", {
      model: input.model,
      prompt: input.prompt,
      system: input.system,
      stream: false,
      options:
        input.maxTokens !== undefined || input.temperature !== undefined
          ? {
              num_predict: input.maxTokens,
              temperature: input.temperature,
            }
          : undefined,
    }, input.signal);
    return {
      model: typeof data.model === "string" ? data.model : input.model,
      text: typeof data.response === "string" ? data.response : "",
      done: data.done ?? true,
      promptTokens:
        typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : null,
      completionTokens: typeof data.eval_count === "number" ? data.eval_count : null,
    };
  }

  /** POST /api/chat — multi-turn chat (stream:false). */
  async chat(input: ChatInput): Promise<ChatOutput> {
    if (input.model.length === 0) {
      throw new ModelManagerError("INVALID_ARGUMENT", "chat: model required");
    }
    if (input.messages.length === 0) {
      throw new ModelManagerError("INVALID_ARGUMENT", "chat: messages required");
    }
    const data = await this.request<{
      model?: string;
      message?: { role?: string; content?: string };
      done?: boolean;
      prompt_eval_count?: number;
      eval_count?: number;
    }>("POST", "/api/chat", {
      model: input.model,
      messages: input.messages,
      stream: false,
      options:
        input.maxTokens !== undefined || input.temperature !== undefined
          ? {
              num_predict: input.maxTokens,
              temperature: input.temperature,
            }
          : undefined,
    }, input.signal);
    const role = data.message?.role;
    return {
      model: typeof data.model === "string" ? data.model : input.model,
      message: {
        role: role === "user" || role === "system" || role === "tool" ? role : "assistant",
        content: typeof data.message?.content === "string" ? data.message.content : "",
      },
      done: data.done ?? true,
      promptTokens:
        typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : null,
      completionTokens: typeof data.eval_count === "number" ? data.eval_count : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Model records (mirror the `models` table in migrations/002_stage2.sql)
// ---------------------------------------------------------------------------

export type ModelStatus =
  | "DISCOVERED"
  | "QUEUED"
  | "DOWNLOADING"
  | "VERIFYING"
  | "INSTALLED"
  | "LOADED"
  | "CANCELLED"
  | "UNINSTALLING"
  | "UNINSTALLED"
  | "FAILED";

export interface ModelRecord {
  modelId: string;
  displayName: string;
  family: ProviderFamily;
  runtime: string;
  status: ModelStatus;
  /** Runtime/installation ref (Ollama tag); never an Agent-facing field. */
  runtimeRef: string;
  weightsPath: string;
  sizeBytes: number;
  capabilities: string[];
  installedAtSec: number | null;
  updatedAtSec: number;
}

export interface ResolvedModel {
  /** Final selection, recorded into run metadata (§30.1). */
  modelId: string;
  family: ProviderFamily;
  runtime: string;
  runtimeRef: string;
  profile: AutoProfile | null;
  /** Why this model won: explicit select vs auto profile vs node default. */
  reason: "explicit" | "task-override" | "node-policy" | "auto-balanced";
}

export interface ResolveModelInput {
  /** Explicit Agent/model select (highest precedence). */
  explicitModelId?: string;
  /** Task-level override (middle precedence). */
  taskModelId?: string;
  /** The one Stage 2 auto profile. */
  profile?: string;
}

// ---------------------------------------------------------------------------
// ModelManager
// ---------------------------------------------------------------------------

export interface ModelManagerOptions {
  /** Node-level shared weights dir (invariant 10). */
  weightsDir?: string;
  nodeDefaultModelId?: string;
  ollama?: OllamaAdapterOptions;
  nowSec?: () => number;
}

export class ModelManager {
  private readonly adapters = new Map<ProviderFamily, ModelRuntimeAdapter>();
  private readonly catalog = new Map<string, ModelRecord>();
  private readonly weightsDir: string;
  private nodeDefaultModelId: string | null;
  private lastResolution: ResolvedModel | null = null;
  private readonly nowSec: () => number;

  constructor(opts?: ModelManagerOptions) {
    // Invariant 17: Ollama is the V1 runtime. Invariant 18: it is only a
    // registered adapter — all routing below goes through the family map.
    const ollama = new OllamaAdapter(opts?.ollama);
    this.adapters.set("ollama", ollama);
    this.weightsDir = opts?.weightsDir ?? "models";
    this.nodeDefaultModelId = opts?.nodeDefaultModelId ?? null;
    this.nowSec = opts?.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  // -- adapter registry (the anti-hardcoding boundary) ------------------------

  /** Look up the adapter for a family. Non-Ollama families are UNSUPPORTED. */
  adapterFor(family: ProviderFamily): ModelRuntimeAdapter {
    const adapter = this.adapters.get(family);
    if (!adapter) {
      throw new ModelManagerError(
        "UNSUPPORTED",
        `provider family "${family}" is not available in Stage 2 (Ollama local runtime only)`,
        { retryable: false, remediation: "select an installed Ollama model" },
      );
    }
    return adapter;
  }

  /**
   * Stage 6 hook: register a future adapter (llama.cpp, vLLM, BYOK
   * families) without changing Agent definitions or call sites.
   */
  registerAdapter(adapter: ModelRuntimeAdapter): void {
    this.adapters.set(adapter.family, adapter);
  }

  /**
   * Provider configuration. Stage 2 has no BYOK: anything outside the
   * local Ollama family is rejected with UNSUPPORTED (§30 deferred).
   */
  configureProvider(family: ProviderFamily, config: { baseUrl?: string }): void {
    if (family !== "ollama") {
      throw new ModelManagerError(
        "UNSUPPORTED",
        `BYOK provider family "${family}" is not supported in Stage 2`,
        { retryable: false },
      );
    }
    const adapter = this.adapterFor("ollama");
    if (adapter instanceof OllamaAdapter && config.baseUrl !== undefined) {
      adapter.setBaseUrl(config.baseUrl);
    }
  }

  getOllamaBaseUrl(): string {
    const adapter = this.adapterFor("ollama");
    if (adapter instanceof OllamaAdapter) return adapter.getBaseUrl();
    return DEFAULT_OLLAMA_BASE_URL;
  }

  // -- shared weights (invariant 10) -------------------------------------------

  /**
   * Node-level shared weights dir. Agents reference shared model IDs and
   * never maintain separate copies of the same local model weights (§31.3).
   */
  sharedWeightsDir(): string {
    return this.weightsDir;
  }

  /** Resolve a model's weights path under the shared dir (no per-Agent copy). */
  weightsPathFor(modelId: string): string {
    if (modelId.length === 0) {
      throw new ModelManagerError("INVALID_ARGUMENT", "modelId required");
    }
    const safe = modelId.replace(/[^A-Za-z0-9._-]+/g, "-");
    return path.join(this.weightsDir, safe);
  }

  // -- catalog ------------------------------------------------------------------

  /** Refresh the catalog from the Ollama runtime (`GET /api/tags`). */
  async refreshCatalog(signal?: AbortSignal): Promise<ModelRecord[]> {
    const entries = await this.adapterFor("ollama").listModels(signal);
    const now = this.nowSec();
    const records: ModelRecord[] = [];
    for (const entry of entries) {
      const prior = this.catalog.get(entry.modelId);
      const record: ModelRecord = {
        modelId: entry.modelId,
        displayName: entry.displayName,
        family: entry.family,
        runtime: "ollama",
        status: prior?.status ?? "INSTALLED",
        runtimeRef: entry.runtimeRef,
        weightsPath: prior?.weightsPath ?? this.weightsPathFor(entry.modelId),
        sizeBytes: entry.sizeBytes,
        capabilities: [...entry.capabilities],
        installedAtSec: prior?.installedAtSec ?? now,
        updatedAtSec: now,
      };
      this.catalog.set(entry.modelId, record);
      records.push({ ...record, capabilities: [...record.capabilities] });
    }
    return records;
  }

  registerCatalogEntry(entry: CatalogEntry): ModelRecord {
    if (entry.family !== "ollama") {
      throw new ModelManagerError(
        "UNSUPPORTED",
        `catalog family "${entry.family}" is not available in Stage 2`,
      );
    }
    const now = this.nowSec();
    const record: ModelRecord = {
      modelId: entry.modelId,
      displayName: entry.displayName,
      family: entry.family,
      runtime: "ollama",
      status: "DISCOVERED",
      runtimeRef: entry.runtimeRef,
      weightsPath: this.weightsPathFor(entry.modelId),
      sizeBytes: entry.sizeBytes,
      capabilities: [...entry.capabilities],
      installedAtSec: null,
      updatedAtSec: now,
    };
    this.catalog.set(entry.modelId, record);
    return { ...record, capabilities: [...record.capabilities] };
  }

  getModel(modelId: string): ModelRecord | null {
    const record = this.catalog.get(modelId);
    if (!record) return null;
    return { ...record, capabilities: [...record.capabilities] };
  }

  listModels(): ModelRecord[] {
    return [...this.catalog.values()].map((r) => ({
      ...r,
      capabilities: [...r.capabilities],
    }));
  }

  /**
   * Move a model through the §58.2 modelInstallation machine. Illegal
   * transitions are rejected deterministically.
   */
  transitionModel(modelId: string, to: ModelStatus): ModelRecord {
    const record = this.catalog.get(modelId);
    if (!record) {
      throw new ModelManagerError("NOT_FOUND", `unknown model "${modelId}"`);
    }
    if (!canTransition("modelInstallation", record.status, to)) {
      throw new ModelManagerError(
        "INVALID_ARGUMENT",
        `illegal modelInstallation transition: ${record.status} -> ${to}`,
      );
    }
    const now = this.nowSec();
    record.status = to;
    record.updatedAtSec = now;
    if (to === "INSTALLED" && record.installedAtSec === null) {
      record.installedAtSec = now;
    }
    return { ...record, capabilities: [...record.capabilities] };
  }

  // -- selection (§30.1 precedence; one auto profile) ----------------------------

  setNodeDefault(modelId: string): void {
    this.nodeDefaultModelId = modelId;
  }

  /**
   * Resolve the model for a Run. Precedence: explicit select >
   * task-override > node-policy; the `auto-balanced` profile fills in only
   * when no explicit selection exists. The returned selection is the final
   * one — the caller records it into run metadata (`model_selection_json`).
   */
  resolveModel(input: ResolveModelInput = {}): ResolvedModel {
    const wanted =
      input.explicitModelId ?? input.taskModelId ?? this.nodeDefaultModelId;
    if (wanted !== null && wanted !== undefined) {
      const record = this.catalog.get(wanted);
      if (!record) {
        throw new ModelManagerError("NOT_FOUND", `unknown model "${wanted}"`, {
          retryable: false,
          remediation: "refreshCatalog() or choose an installed model",
        });
      }
      const resolved: ResolvedModel = {
        modelId: record.modelId,
        family: record.family,
        runtime: record.runtime,
        runtimeRef: record.runtimeRef,
        profile: null,
        reason:
          input.explicitModelId !== undefined
            ? "explicit"
            : input.taskModelId !== undefined
              ? "task-override"
              : "node-policy",
      };
      this.lastResolution = resolved;
      return { ...resolved };
    }
    // No explicit selection: the single auto profile decides.
    const profile = input.profile ?? AUTO_PROFILE;
    if (profile !== AUTO_PROFILE) {
      throw new ModelManagerError(
        "UNSUPPORTED",
        `unknown routing profile "${profile}" (Stage 2 supports only "${AUTO_PROFILE}")`,
      );
    }
    const fallback = this.pickBalanced();
    if (!fallback) {
      throw new ModelManagerError("PROVIDER_UNAVAILABLE", "no installed model available", {
        retryable: true,
        remediation: "install a model, then retry",
      });
    }
    const resolved: ResolvedModel = {
      modelId: fallback.modelId,
      family: fallback.family,
      runtime: fallback.runtime,
      runtimeRef: fallback.runtimeRef,
      profile: AUTO_PROFILE,
      reason: "auto-balanced",
    };
    this.lastResolution = resolved;
    return { ...resolved };
  }

  /** The final selection from the last `resolveModel()` call, if any. */
  lastResolvedModel(): ResolvedModel | null {
    return this.lastResolution ? { ...this.lastResolution } : null;
  }

  /** `auto-balanced`: prefer a LOADED model, else INSTALLED, by smallest size. */
  private pickBalanced(): ModelRecord | null {
    const usable = [...this.catalog.values()].filter(
      (r) => r.status === "LOADED" || r.status === "INSTALLED",
    );
    if (usable.length === 0) return null;
    usable.sort((a, b) => {
      const rank = (s: ModelStatus): number => (s === "LOADED" ? 0 : 1);
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
      if (a.sizeBytes !== b.sizeBytes) return a.sizeBytes - b.sizeBytes;
      return a.modelId < b.modelId ? -1 : 1;
    });
    const winner = usable[0];
    if (!winner) return null;
    return winner;
  }

  // -- inference (routed through the family adapter) -------------------------------

  /** Generate via the resolved model's runtime adapter. */
  async generate(resolved: ResolvedModel, input: Omit<GenerateInput, "model">): Promise<GenerateOutput> {
    return this.adapterFor(resolved.family).generate({
      ...input,
      model: resolved.runtimeRef,
    });
  }

  /** Chat via the resolved model's runtime adapter. */
  async chat(resolved: ResolvedModel, input: Omit<ChatInput, "model">): Promise<ChatOutput> {
    return this.adapterFor(resolved.family).chat({
      ...input,
      model: resolved.runtimeRef,
    });
  }

  // -- persistence mapping (control plane <-> `models` table) -----------------------

  /** Serialize a record to the `models` table shape (JSON columns as TEXT). */
  static toRow(record: ModelRecord): {
    model_id: string;
    display_name: string;
    family: string;
    runtime: string;
    status: string;
    manifest_json: string;
    weights_path: string;
    size_bytes: number;
    capabilities_json: string;
    installed_at: number | null;
    updated_at: number;
  } {
    return {
      model_id: record.modelId,
      display_name: record.displayName,
      family: record.family,
      runtime: record.runtime,
      status: record.status,
      manifest_json: JSON.stringify({ runtimeRef: record.runtimeRef }),
      weights_path: record.weightsPath,
      size_bytes: record.sizeBytes,
      capabilities_json: JSON.stringify(record.capabilities),
      installed_at: record.installedAtSec,
      updated_at: record.updatedAtSec,
    };
  }

  /** Load catalog records previously stored with `toRow()`. */
  loadRows(
    rows: Array<{
      model_id: string;
      display_name: string;
      family: string;
      runtime: string;
      status: string;
      manifest_json: string;
      weights_path: string;
      size_bytes: number;
      capabilities_json: string;
      installed_at: number | null;
      updated_at: number;
    }>,
  ): void {
    for (const row of rows) {
      if (row.family !== "ollama") continue; // Stage 2 admits Ollama rows only.
      let runtimeRef = row.model_id;
      let capabilities: string[] = [];
      try {
        const manifest = JSON.parse(row.manifest_json) as { runtimeRef?: string };
        if (typeof manifest.runtimeRef === "string") runtimeRef = manifest.runtimeRef;
      } catch {
        // Keep the default ref; never fail the whole load on one row.
      }
      try {
        const caps = JSON.parse(row.capabilities_json) as unknown;
        if (Array.isArray(caps)) capabilities = caps.filter((c): c is string => typeof c === "string");
      } catch {
        // Keep empty capabilities; never fail the whole load on one row.
      }
      this.catalog.set(row.model_id, {
        modelId: row.model_id,
        displayName: row.display_name,
        family: "ollama",
        runtime: row.runtime,
        status: row.status as ModelStatus,
        runtimeRef,
        weightsPath: row.weights_path,
        sizeBytes: row.size_bytes,
        capabilities,
        installedAtSec: row.installed_at,
        updatedAtSec: row.updated_at,
      });
    }
  }
}
