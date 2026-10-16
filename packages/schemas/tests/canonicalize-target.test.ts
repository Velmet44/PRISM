import { describe, expect, it } from "vitest";
import {
  canonicalizeTarget,
  isCanonicalTarget,
} from "../src/auth.js";
import { toCanonicalJson } from "../src/jcs.js";

describe("canonicalizeTarget", () => {
  const cases: Array<[string, string]> = [
    ["/v1/agents", "/v1/agents"],
    ["/a/./b", "/a/b"],
    ["/a/../b", "/b"],
    ["/a/b/../c", "/a/c"],
    ["/%7euser", "/~user"],
    ["/a%2Fb", "/a%2Fb"],
    ["/t?b=2&a=1", "/t?b=2&a=1"],
    ["/t?a=1&a=2", "/t?a=1&a=2"],
    ["/t?b=%7e", "/t?b=~"],
    ["/v1/ws/tickets", "/v1/ws/tickets"],
  ];
  it.each(cases)("normalizes %s", (raw, expected) => {
    expect(canonicalizeTarget(raw)).toBe(expected);
    expect(isCanonicalTarget(expected)).toBe(true);
  });

  const invalid = [
    "",
    "relative/path",
    "/a/%00/b",
    "/a/%2",
    "/../escape",
    "/v1/x#frag",
    "/t?a=1#frag",
    "/a/b/%",
  ];
  it.each(invalid)("rejects %s", (raw) => {
    expect(() => canonicalizeTarget(raw)).toThrow();
    expect(isCanonicalTarget(raw)).toBe(false);
  });

  it("detects non-canonical but equivalent forms", () => {
    expect(isCanonicalTarget("/a/%2f/b")).toBe(false);
    expect(canonicalizeTarget("/a/%2f/b")).toBe("/a/%2F/b");
    expect(isCanonicalTarget("/a/./b")).toBe(false);
  });
});

describe("toCanonicalJson golden vector", () => {
  it("sorts keys and omits whitespace deterministically", () => {
    const doc = {
      v: 1,
      token_sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      target: "/v1/agents",
      node_id: "node-1",
      method: "GET",
      jti: "0123456789abcdef0123456789abcdef",
      iat: 1728000000,
      device_id: "dev-1",
      content_type: "application/json",
      content_encoding: "identity",
      body_sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      session_id: "sess-1",
    };
    expect(toCanonicalJson(doc)).toBe(
      '{"body_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","content_encoding":"identity","content_type":"application/json","device_id":"dev-1","iat":1728000000,"jti":"0123456789abcdef0123456789abcdef","method":"GET","node_id":"node-1","session_id":"sess-1","target":"/v1/agents","token_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","v":1}',
    );
  });

  it("rejects floats and exotic values", () => {
    expect(() => toCanonicalJson({ v: 1.5 })).toThrow();
    expect(() => toCanonicalJson(undefined)).toThrow();
  });
});
