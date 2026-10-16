/**
 * Stage 1 entrypoint: re-export every Stage 1 backend module.
 *
 * The public Node API (`api`) and the Node Manager (`node-manager`) keep
 * separate listeners, route registries, middleware chains, authorization
 * policies, and audit streams (spec §6.1); re-exporting them from one
 * entrypoint does not merge those runtime objects.
 */
export * from "./config/index.js";
export * from "./storage/index.js";
export * from "./identity/index.js";
export * from "./auth/index.js";
export * from "./devices/index.js";
export * from "./node-manager/index.js";
export * from "./api/index.js";
export * from "./updates/index.js";
export * from "./installer/index.js";

// `isAllowedHostOrigin` exists in both config (listener-based, strict) and
// node-manager (NM-specific, platform-based). The NM form is the barrel
// default (tests + NM call sites); the config form is also exported under an
// alias for deep listener checks. Deep imports are unaffected.
export { SecretsLockedError } from "./auth/index.js";
export { isAllowedHostOrigin } from "./node-manager/index.js";
export { isAllowedHostOrigin as isAllowedHostOriginForListener } from "./config/index.js";
