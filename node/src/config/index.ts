/**
 * PRISM Node configuration — Stage 1.
 *
 * Covers spec §49 (data root layout), §8 (OS targets, support manifest,
 * preflight → UNSUPPORTED), §7.2 (reboot DEGRADED/secrets_locked) and
 * §6.1 (per-listener Host/Origin allowlists).
 *
 * No native dependencies. Only node:fs / node:os / node:path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** PRISM release version served by this Node build (Stage 1 stub). */
export const PRISM_VERSION = "0.1.0";

/** Update channel reported by Stage 1 health stubs. */
export type UpdateChannel = "stable" | "beta" | "dev";

/** Frozen preflight code for an unsupported combination (§8). */
export const UNSUPPORTED = "UNSUPPORTED" as const;
export type UnsupportedCode = typeof UNSUPPORTED;

/**
 * Conceptual data-root layout (§49). Values are paths relative to the
 * data root, except `databaseFile` which is also relative.
 *
 * ```text
 * PRISM data root/
 * ├── node/            # identity-public-metadata, config, update-state
 * ├── database/prism.sqlite
 * ├── agents/<agent-id>/{definition,state,workspace,memory,browser}
 * ├── artifacts/       # content-addressed, immutable, control-plane-owned
 * ├── models/{catalog,installed}
 * ├── backups/
 * ├── logs/
 * └── runtime/
 * ```
 */
export const DATA_LAYOUT = {
  node: "node",
  nodeConfig: "node/config.json",
  nodeIdentityMeta: "node/identity.json",
  nodeUpdateState: "node/update-state.json",
  installMarker: "node/installed.json",
  databaseDir: "database",
  databaseFile: "database/prism.sqlite",
  agents: "agents",
  artifacts: "artifacts",
  models: "models",
  modelsCatalog: "models/catalog",
  modelsInstalled: "models/installed",
  backups: "backups",
  logs: "logs",
  runtime: "runtime",
} as const;

export type DataLayoutKey = keyof typeof DATA_LAYOUT;

/** Directories (relative to the data root) that must exist. */
export const DATA_DIRECTORIES: readonly string[] = [
  DATA_LAYOUT.node,
  DATA_LAYOUT.databaseDir,
  DATA_LAYOUT.agents,
  DATA_LAYOUT.artifacts,
  DATA_LAYOUT.models,
  DATA_LAYOUT.modelsCatalog,
  DATA_LAYOUT.modelsInstalled,
  DATA_LAYOUT.backups,
  DATA_LAYOUT.logs,
  DATA_LAYOUT.runtime,
];

/**
 * Resolve the persistent data root.
 *
 * Priority: explicit argument → `$PRISM_DATA_ROOT` → platform default.
 * The Linux/WSL2 default lives inside the Linux filesystem
 * (`/var/lib/prism`); per §8.2 data MUST NOT default under `/mnt/c`.
 */
export function resolveDataRoot(explicit?: string): string {
  const fromArg = explicit?.trim();
  if (fromArg !== undefined && fromArg !== "") {
    return path.resolve(fromArg);
  }
  const fromEnv = process.env["PRISM_DATA_ROOT"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return path.resolve(fromEnv);
  }
  return "/var/lib/prism";
}

/** Absolute database file path for a data root. */
export function resolveDatabasePath(dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), DATA_LAYOUT.databaseFile);
}

/** Join segments onto the data root. */
export function dataPath(dataRoot: string, ...segments: string[]): string {
  return path.join(dataRoot, ...segments);
}

/** Create every directory in {@link DATA_DIRECTORIES} (idempotent). */
export function ensureDataDirs(dataRoot: string): string[] {
  const created: string[] = [];
  for (const relative of DATA_DIRECTORIES) {
    const absolute = path.join(dataRoot, relative);
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    created.push(absolute);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Listener Host/Origin policy (§6.1, §37.2)
// ---------------------------------------------------------------------------

/** Named Node listeners with distinct Host/Origin rules. */
export type ListenerName =
  | "public"
  | "node-manager-uds-bridge"
  | "node-manager-wsl2";

export interface ListenerOriginPolicy {
  /** Host header values accepted on this listener (no port). */
  allowedHosts: readonly string[];
  /** Origin header values accepted on this listener. */
  allowedOrigins: readonly string[];
}

/**
 * Linux UDS bridge policy (§6.1): `http://localhost` and
 * `http://127.0.0.1` only. Anything else is rejected.
 */
export const UDS_BRIDGE_POLICY: ListenerOriginPolicy = {
  allowedHosts: ["localhost", "127.0.0.1"],
  allowedOrigins: ["http://localhost", "http://127.0.0.1"],
};

/**
 * WSL2 loopback policy (§6.1, §8.2): the UDS-bridge origins plus the
 * configured WSL host address (e.g. the contents of
 * `/etc/resolv.conf` nameserver on WSL2). The address is deployment
 * specific, so callers append it via {@link wsl2LoopbackPolicy}.
 */
export function wsl2LoopbackPolicy(wslHostAddress?: string): ListenerOriginPolicy {
  const origins = [...UDS_BRIDGE_POLICY.allowedOrigins];
  const hosts = [...UDS_BRIDGE_POLICY.allowedHosts];
  const trimmed = wslHostAddress?.trim();
  if (trimmed !== undefined && trimmed !== "") {
    hosts.push(trimmed);
    origins.push(`http://${trimmed}`);
  }
  return { allowedHosts: hosts, allowedOrigins: origins };
}

/** Per-listener allowlists. The public listener never trusts loopback shortcuts. */
export const LISTENER_ORIGIN_POLICY: Record<
  "public" | "node-manager-uds-bridge",
  ListenerOriginPolicy
> = {
  // Public API: strict Host/Origin validation against explicit config.
  // Empty by default — loadConfig() fills it from node/config.json.
  public: { allowedHosts: [], allowedOrigins: [] },
  "node-manager-uds-bridge": UDS_BRIDGE_POLICY,
};

/**
 * Strict Host + Origin check for a listener. Comparison is exact
 * (case-insensitive host, case-sensitive origin); ports in Host are
 * stripped before comparison. Missing Origin on a non-GET request fails
 * closed.
 */
export function isAllowedHostOrigin(
  listener: ListenerName,
  host: string,
  origin: string | null | undefined,
  opts?: { wslHostAddress?: string; publicPolicy?: ListenerOriginPolicy },
): boolean {
  const policy: ListenerOriginPolicy =
    listener === "node-manager-wsl2"
      ? wsl2LoopbackPolicy(opts?.wslHostAddress)
      : listener === "node-manager-uds-bridge"
        ? LISTENER_ORIGIN_POLICY["node-manager-uds-bridge"]
        : (opts?.publicPolicy ?? LISTENER_ORIGIN_POLICY.public);

  const hostNoPort = host.split(":")[0]?.trim().toLowerCase() ?? "";
  if (hostNoPort === "" || !policy.allowedHosts.includes(hostNoPort)) {
    return false;
  }
  if (origin === null || origin === undefined || origin === "") {
    return false;
  }
  return policy.allowedOrigins.includes(origin);
}

// ---------------------------------------------------------------------------
// Node config file (§49 + §7.1 step 4)
// ---------------------------------------------------------------------------

export interface PrismConfig {
  version: number;
  dataRoot: string;
  databasePath: string;
  channel: UpdateChannel;
  publicListener: {
    host: string;
    port: number;
    allowedHosts: string[];
    allowedOrigins: string[];
  };
  nodeManager: {
    /** Linux: UDS path. WSL2: loopback host/port. */
    socketPath: string;
    wslHostAddress: string | null;
  };
}

/** Sensible Stage 1 defaults; config file + overrides win. */
export function defaultConfig(dataRoot?: string): PrismConfig {
  const root = resolveDataRoot(dataRoot);
  return {
    version: 1,
    dataRoot: root,
    databasePath: path.join(root, DATA_LAYOUT.databaseFile),
    channel: "stable",
    publicListener: {
      host: "127.0.0.1",
      port: 4820,
      allowedHosts: [],
      allowedOrigins: [],
    },
    nodeManager: {
      socketPath: path.join(root, DATA_LAYOUT.runtime, "node-manager.sock"),
      wslHostAddress: null,
    },
  };
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load the Node config. Reads `<dataRoot>/node/config.json` when present
 * and merges (defaults ← file ← explicit overrides ← supported env vars).
 * Never throws for a missing file; returns defaults instead.
 */
export function loadConfig(
  overrides?: Partial<PrismConfig> & {
    configFile?: string;
    publicListener?: Partial<PrismConfig["publicListener"]>;
    nodeManager?: Partial<PrismConfig["nodeManager"]>;
  },
): PrismConfig {
  const base = defaultConfig(overrides?.dataRoot);
  const configFile =
    overrides?.configFile ?? path.join(base.dataRoot, DATA_LAYOUT.nodeConfig);
  const file = readJsonFile(configFile);

  const channelEnv = process.env["PRISM_CHANNEL"];
  const channel: UpdateChannel =
    overrides?.channel ??
    (channelEnv === "beta" || channelEnv === "dev" || channelEnv === "stable"
      ? channelEnv
      : ((file?.["channel"] as UpdateChannel | undefined) ?? base.channel));

  const filePublic = (file?.["publicListener"] as Record<string, unknown> | undefined) ?? {};
  const fileNm = (file?.["nodeManager"] as Record<string, unknown> | undefined) ?? {};

  const asStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

  return {
    version: 1,
    dataRoot: overrides?.dataRoot ?? (typeof file?.["dataRoot"] === "string" ? file["dataRoot"] : base.dataRoot),
    databasePath:
      overrides?.databasePath ??
      (typeof file?.["databasePath"] === "string" ? file["databasePath"] : base.databasePath),
    channel,
    publicListener: {
      host:
        overrides?.publicListener?.host ??
        (typeof filePublic["host"] === "string" ? filePublic["host"] : base.publicListener.host),
      port:
        overrides?.publicListener?.port ??
        (typeof filePublic["port"] === "number" ? filePublic["port"] : base.publicListener.port),
      allowedHosts:
        overrides?.publicListener?.allowedHosts ?? asStringArray(filePublic["allowedHosts"]),
      allowedOrigins:
        overrides?.publicListener?.allowedOrigins ?? asStringArray(filePublic["allowedOrigins"]),
    },
    nodeManager: {
      socketPath:
        overrides?.nodeManager?.socketPath ??
        (typeof fileNm["socketPath"] === "string" ? fileNm["socketPath"] : base.nodeManager.socketPath),
      wslHostAddress:
        overrides?.nodeManager?.wslHostAddress ??
        (typeof fileNm["wslHostAddress"] === "string" ? fileNm["wslHostAddress"] : null),
    },
  };
}

// ---------------------------------------------------------------------------
// Platform support preflight (§8 + ADR 0001)
// ---------------------------------------------------------------------------

/** Canonical `os_distro_release` values certified in Stage 1 (ADR 0001). */
export const SUPPORTED_DISTROS = [
  "ubuntu-24.04",
  "debian-12",
  "wsl2-ubuntu-24.04",
] as const;

export type SupportedDistro = (typeof SUPPORTED_DISTROS)[number];

/** Certified (distro, arch) combinations for Stage 1. */
export const SUPPORTED_COMBINATIONS: readonly {
  osDistroRelease: SupportedDistro;
  arch: "x86_64" | "aarch64";
}[] = [
  { osDistroRelease: "ubuntu-24.04", arch: "x86_64" },
  { osDistroRelease: "ubuntu-24.04", arch: "aarch64" },
  { osDistroRelease: "debian-12", arch: "x86_64" },
  { osDistroRelease: "wsl2-ubuntu-24.04", arch: "x86_64" },
];

export interface HostInfo {
  /** Canonical distro id, e.g. `ubuntu-24.04`, `debian-12`, `wsl2-ubuntu-24.04`. */
  osDistroRelease: string;
  /** Canonical arch: `x86_64` or `aarch64`. */
  arch: string;
  /** True when running inside WSL2. */
  wsl: boolean;
}

export interface SupportCombinationInput {
  os_distro_release: string;
  arch: string;
}

export interface SupportManifestInput {
  manifest_version: number;
  prism_version: string;
  combinations: SupportCombinationInput[];
}

export interface PreflightResult {
  /** True only when the host matches a listed combination. */
  supported: boolean;
  /**
   * True when the Node must run DEGRADED: status is served but sandbox
   * admission is blocked (§8.1). Always true when `supported` is false.
   */
  degraded: boolean;
  /** `OK` when supported, otherwise `UNSUPPORTED`. */
  code: "OK" | UnsupportedCode;
  /**
   * Remediation for the operator when unsupported (§8.1). Present only
   * when `supported` is false.
   */
  missing_requirement?: string;
  matchedCombination?: SupportCombinationInput | null;
}

/** Map Node.js `os.arch()` to the manifest arch vocabulary. */
export function normalizeArch(nodeArch: string): string {
  if (nodeArch === "x64") return "x86_64";
  if (nodeArch === "arm64") return "aarch64";
  return nodeArch;
}

/** Parse `/etc/os-release` text into `{id, versionId}`. */
export function parseOsRelease(text: string): { id: string; versionId: string } {
  let id = "";
  let versionId = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("ID=")) {
      id = trimmed.slice(3).replace(/^"|"$/g, "").toLowerCase();
    } else if (trimmed.startsWith("VERSION_ID=")) {
      versionId = trimmed.slice(11).replace(/^"|"$/g, "");
    }
  }
  return { id, versionId };
}

/** True when the kernel/proc markers indicate WSL2. */
export function looksLikeWsl(procVersionText: string, env?: NodeJS.ProcessEnv): boolean {
  const haystack = procVersionText.toLowerCase();
  if (haystack.includes("wsl2") || haystack.includes("microsoft-standard-wsl2")) {
    return true;
  }
  const e = env ?? process.env;
  return (
    typeof e["WSL_DISTRO_NAME"] === "string" ||
    typeof e["WSL_INTEROP"] === "string" ||
    typeof e["WSLENV"] === "string"
  );
}

/**
 * Detect the host's canonical distro/arch triple. All inputs are
 * overridable for tests; by default they are read from the OS.
 */
export function detectHostInfo(detectors?: {
  osReleaseText?: string;
  arch?: string;
  procVersionText?: string;
  env?: NodeJS.ProcessEnv;
}): HostInfo {
  let osReleaseText = detectors?.osReleaseText;
  if (osReleaseText === undefined) {
    try {
      osReleaseText = fs.readFileSync("/etc/os-release", "utf8");
    } catch {
      osReleaseText = "";
    }
  }
  let procVersionText = detectors?.procVersionText;
  if (procVersionText === undefined) {
    try {
      procVersionText = fs.readFileSync("/proc/version", "utf8");
    } catch {
      procVersionText = "";
    }
  }
  const { id, versionId } = parseOsRelease(osReleaseText);
  const wsl = looksLikeWsl(procVersionText, detectors?.env);
  const distro = id !== "" && versionId !== "" ? `${id}-${versionId}` : "unknown";
  return {
    osDistroRelease: wsl && distro === "ubuntu-24.04" ? "wsl2-ubuntu-24.04" : distro,
    arch: normalizeArch(detectors?.arch ?? os.arch()),
    wsl,
  };
}

/**
 * Preflight the host against the support manifest (§8.1).
 *
 * - A listed combination → `{supported:true, degraded:false, code:"OK"}`.
 * - Anything else → `UNSUPPORTED` with a `missing_requirement` remediation
 *   and `degraded:true` (serve status, block sandbox admission, show the
 *   unsupported-combo banner). Baseline capability alone never implies
 *   support.
 */
export function preflightSupportManifest(
  host?: HostInfo,
  manifest?: SupportManifestInput,
): PreflightResult {
  const current: HostInfo = host ?? detectHostInfo();
  const combinations: SupportCombinationInput[] =
    manifest?.combinations ??
    SUPPORTED_COMBINATIONS.map((entry) => ({
      os_distro_release: entry.osDistroRelease,
      arch: entry.arch,
    }));

  const distro = current.osDistroRelease.toLowerCase();
  const arch = current.arch.toLowerCase();

  const matched =
    combinations.find(
      (combo) =>
        combo.os_distro_release.toLowerCase() === distro &&
        combo.arch.toLowerCase() === arch,
    ) ?? null;

  if (matched !== null) {
    return { supported: true, degraded: false, code: "OK", matchedCombination: matched };
  }

  const knownDistro = combinations.some(
    (combo) => combo.os_distro_release.toLowerCase() === distro,
  );
  const missing_requirement = knownDistro
    ? `Architecture ${current.arch} is not supported on ${current.osDistroRelease}. ` +
      `Supported arches here: ${combinations
        .filter((combo) => combo.os_distro_release.toLowerCase() === distro)
        .map((combo) => combo.arch)
        .join(", ") || "none"}. See installer/README.md and the release support-manifest.json.`
    : `OS combination ${current.osDistroRelease}/${current.arch} is not listed in the release ` +
      `support-manifest.json (code ${UNSUPPORTED}). Supported: ${SUPPORTED_COMBINATIONS.map(
        (combo) => `${combo.osDistroRelease}/${combo.arch}`,
      ).join(", ")}. Install Ubuntu 24.04 or Debian 12, or run WSL2 Ubuntu 24.04 on Windows.`;

  return {
    supported: false,
    degraded: true,
    code: UNSUPPORTED,
    missing_requirement,
    matchedCombination: null,
  };
}
