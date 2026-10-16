/**
 * Stage 1 boundary tests (spec §6.1, §6.2):
 * the Node Manager / public API split, Tier-5 sole surface, 60s single-use
 * action-bound assertions, helper rotation, Host/Origin allowlist, and
 * locked-store behavior.
 */
import { describe, expect, it } from "vitest";
import {
  CHALLENGE_TTL_MS,
  NM_AUDIT,
  NM_MIDDLEWARE,
  NM_ROUTES,
  ROTATE_HELPER_ACTION,
  SecretsLockedError,
  createNodeManager,
  isAllowedHostOrigin,
  mintChallenge,
  resetNodeManagerForTests,
  verifyHelperAssertion,
} from "../src/node-manager/index.js";
import {
  PUBLIC_AUDIT,
  PUBLIC_MIDDLEWARE,
  PUBLIC_ROUTES,
  buildPublicHandler,
  isPublicTier5Blocked,
  loopbackIsNotAuth,
} from "../src/api/index.js";
import type { Tier5AssertionDoc } from "@prism/schemas";
import {
  generateHelperKeyPair,
  serveOnLoopback,
  signTier5Assertion,
} from "./helpers.js";

const ACTION_HASH = "ab".repeat(32);
const NODE_ID = "node-test-1";

function makeAssertion(
  challenge: { challenge_id: string; nonce: string; action_hash: string; issued_at: string; expires_at: string },
  overrides: Partial<Tier5AssertionDoc> = {},
): Tier5AssertionDoc {
  return {
    node_id: NODE_ID as Tier5AssertionDoc["node_id"],
    challenge_id: challenge.challenge_id as Tier5AssertionDoc["challenge_id"],
    session_id: "sess-test-1",
    action_hash: challenge.action_hash,
    os_principal: "linux-uid:1000",
    nonce: challenge.nonce,
    issued_at: challenge.issued_at,
    expires_at: challenge.expires_at,
    ...overrides,
  };
}

describe("Stage 1 Node Manager boundary", () => {
  it("(1) public and Node Manager registries/middleware/audit are separate objects", () => {
    expect(NM_ROUTES).not.toBe(PUBLIC_ROUTES);
    expect(NM_MIDDLEWARE).not.toBe(PUBLIC_MIDDLEWARE);
    expect(NM_AUDIT).not.toBe(PUBLIC_AUDIT);

    // Mutating one side must not leak into the other: never shared.
    const marker = (() => undefined) as unknown as (typeof NM_MIDDLEWARE)[number];
    NM_MIDDLEWARE.push(marker);
    try {
      expect(PUBLIC_MIDDLEWARE).not.toContain(marker);
    } finally {
      NM_MIDDLEWARE.pop();
    }

    // The public listener carries no Node Manager routes and vice versa.
    expect(Object.values(PUBLIC_ROUTES).some((r) => r.path.startsWith("/nm/"))).toBe(false);
    expect(Object.values(NM_ROUTES).some((r) => r.path.startsWith("/v1/"))).toBe(false);
  });

  it("(2) Tier-5 via the public listener is UNAUTHORIZED with nm_required", async () => {
    expect(isPublicTier5Blocked()).toBe(true);
    const server = await serveOnLoopback(buildPublicHandler());
    try {
      for (const path of ["/nm/challenges?action_hash=abc", "/nm/unlock", "/nm/tier5/resolve"]) {
        const res = await fetch(`${server.baseUrl}${path}`);
        expect(res.status).toBe(403);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body["code"]).toBe("UNAUTHORIZED");
        expect(body["remediation"]).toBe("nm_required");
      }
    } finally {
      await server.close();
    }
  });

  it("(3) loopback reachability alone does not authenticate", () => {
    // Documented invariant: loopback is transport isolation, not auth.
    expect(loopbackIsNotAuth).toBe(true);

    const nm = createNodeManager();
    nm.pinHelperKey(generateHelperKeyPair().publicKeyPem);
    const challenge = nm.mintChallenge(ACTION_HASH);

    // A request arriving from 127.0.0.1 with NO helper assertion is denied.
    const denied = nm.authorizeTier5Request({
      assertion: undefined,
      expectedActionHash: ACTION_HASH,
      remoteAddress: "127.0.0.1",
    });
    expect(denied.ok).toBe(false);

    // The module-level verifier agrees: no assertion -> reject.
    resetNodeManagerForTests();
    expect(
      verifyHelperAssertion(undefined, challenge.action_hash).ok,
    ).toBe(false);
  });

  it("(4) challenges expire after 60s and are single-use", () => {
    const nm = createNodeManager();
    const keys = generateHelperKeyPair();
    nm.pinHelperKey(keys.publicKeyPem);

    const t0 = Date.now();
    const challenge = nm.mintChallenge(ACTION_HASH, { now: t0 });
    expect(challenge.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(challenge.expires_at) - Date.parse(challenge.issued_at)).toBe(
      CHALLENGE_TTL_MS,
    );

    const doc = makeAssertion(challenge);
    const signed = { ...doc, signature: signTier5Assertion(doc, keys.privateKeyPem) };

    // Expired after the 60s window.
    const expired = nm.verifyHelperAssertion(signed, ACTION_HASH, {
      now: t0 + 61_000,
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.error.code).toBe("EXPIRED");
    }

    // Fresh challenge: first presentation verifies ...
    const t1 = Date.now();
    const fresh = nm.mintChallenge(ACTION_HASH, { now: t1 });
    const freshDoc = makeAssertion(fresh);
    const freshSigned = {
      ...freshDoc,
      signature: signTier5Assertion(freshDoc, keys.privateKeyPem),
    };
    expect(nm.verifyHelperAssertion(freshSigned, ACTION_HASH, { now: t1 }).ok).toBe(true);

    // ... second presentation of the same assertion is rejected (single-use).
    const replay = nm.verifyHelperAssertion(freshSigned, ACTION_HASH, { now: t1 });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe("REUSED");
    }

    // Action binding: the same assertion presented for another action fails.
    const t2 = Date.now();
    const other = nm.mintChallenge("cd".repeat(32), { now: t2 });
    const otherDoc = makeAssertion(other);
    const otherSigned = {
      ...otherDoc,
      signature: signTier5Assertion(otherDoc, keys.privateKeyPem),
    };
    const mismatch = nm.verifyHelperAssertion(otherSigned, ACTION_HASH, { now: t2 });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe("ACTION_MISMATCH");
    }
  });

  it("(5) helper rotation atomically swaps the pin and revokes the old key", () => {
    const nm = createNodeManager();
    const oldKeys = generateHelperKeyPair();
    const newKeys = generateHelperKeyPair();
    const { pinnedKeyHash: oldHash } = nm.pinHelperKey(oldKeys.publicKeyPem);

    const t0 = Date.now();
    const rotationChallenge = nm.mintChallenge(ROTATE_HELPER_ACTION, { now: t0 });
    const rotationDoc: Tier5AssertionDoc = {
      node_id: NODE_ID as Tier5AssertionDoc["node_id"],
      challenge_id: rotationChallenge.challenge_id as Tier5AssertionDoc["challenge_id"],
      session_id: "sess-rotate-1",
      action_hash: ROTATE_HELPER_ACTION,
      os_principal: "linux-uid:0",
      nonce: rotationChallenge.nonce,
      issued_at: rotationChallenge.issued_at,
      expires_at: rotationChallenge.expires_at,
    };
    const rotation = {
      ...rotationDoc,
      signature: signTier5Assertion(rotationDoc, oldKeys.privateKeyPem),
    };

    // Rotation without an explicit local confirmation is refused.
    const unconfirmed = nm.rotateHelperKey({
      rotationAssertion: rotation,
      newHelperPublicKeyPem: newKeys.publicKeyPem,
      localConfirmation: false,
      now: t0,
    });
    expect(unconfirmed.ok).toBe(false);

    const rotated = nm.rotateHelperKey({
      rotationAssertion: rotation,
      newHelperPublicKeyPem: newKeys.publicKeyPem,
      localConfirmation: true,
      now: t0,
    });
    expect(rotated.ok).toBe(true);
    expect(nm.getPinnedHelperKeyHash()).not.toBe(oldHash);
    expect(nm.isHelperKeyRevoked(oldHash)).toBe(true);

    // The old key no longer verifies for new assertions ...
    const t1 = Date.now();
    const challenge = nm.mintChallenge(ACTION_HASH, { now: t1 });
    const oldSigned = {
      ...makeAssertion(challenge),
      signature: signTier5Assertion(makeAssertion(challenge), oldKeys.privateKeyPem),
    };
    const oldResult = nm.verifyHelperAssertion(oldSigned, ACTION_HASH, { now: t1 });
    expect(oldResult.ok).toBe(false);

    // ... while the new key does.
    const t2 = Date.now();
    const challenge2 = nm.mintChallenge(ACTION_HASH, { now: t2 });
    const newDoc = makeAssertion(challenge2);
    const newSigned = {
      ...newDoc,
      signature: signTier5Assertion(newDoc, newKeys.privateKeyPem),
    };
    expect(nm.verifyHelperAssertion(newSigned, ACTION_HASH, { now: t2 }).ok).toBe(true);
  });

  it("(6) Host/Origin validation rejects unexpected values", () => {
    expect(isAllowedHostOrigin("localhost:3100", "http://localhost:3100", "linux")).toBe(true);
    expect(isAllowedHostOrigin("127.0.0.1", "http://127.0.0.1", "linux")).toBe(true);
    // Non-browser callers send no Origin: Host allowlist still applies.
    expect(isAllowedHostOrigin("localhost", null, "linux")).toBe(true);

    // Unexpected hosts, origins, and schemes are rejected.
    expect(isAllowedHostOrigin("evil.example.com", "http://evil.example.com", "linux")).toBe(false);
    expect(isAllowedHostOrigin("localhost", "https://evil.example.com", "linux")).toBe(false);
    expect(isAllowedHostOrigin("localhost", "https://localhost", "linux")).toBe(false);
    expect(isAllowedHostOrigin("", "http://localhost", "linux")).toBe(false);
    expect(isAllowedHostOrigin("localhost", "not-a-url", "linux")).toBe(false);

    // Linux never admits the WSL host address; wsl2 does when configured.
    expect(isAllowedHostOrigin("172.20.0.2", "http://172.20.0.2", "linux")).toBe(false);
    expect(
      isAllowedHostOrigin("172.20.0.2", "http://172.20.0.2", "wsl2", "172.20.0.2"),
    ).toBe(true);
    expect(
      isAllowedHostOrigin("172.20.0.3", "http://172.20.0.3", "wsl2", "172.20.0.2"),
    ).toBe(false);
  });

  it("(7) locked store blocks secret ops but allows unlock/diagnostics", () => {
    const nm = createNodeManager({ secretsLocked: true });
    expect(nm.isSecretsLocked()).toBe(true);

    // Secret-material operations are blocked and report SECRETS_LOCKED, never success.
    expect(() => nm.requireUnlocked()).toThrow(SecretsLockedError);
    expect(nm.canOperateWhileLocked("secret")).toBe(false);

    // Local unlock and non-secret diagnostics stay usable while locked.
    expect(nm.canOperateWhileLocked("unlock")).toBe(true);
    expect(nm.canOperateWhileLocked("diagnostics")).toBe(true);

    // After unlock, secret operations proceed.
    nm.setSecretsLocked(false);
    expect(() => nm.requireUnlocked()).not.toThrow();

    // Module-level default instance fails closed too.
    resetNodeManagerForTests();
    expect(() => mintChallenge(ACTION_HASH)).not.toThrow();
  });
});
