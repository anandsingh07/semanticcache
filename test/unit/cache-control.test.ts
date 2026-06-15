import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { parseCacheControl } from "../../src/cache/cache-control.js";

// Build a fake Express request that only implements header() — that's all parseCacheControl
// touches. Header lookups are case-insensitive in Express; we lowercase keys here.
function fakeReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

describe("parseCacheControl", () => {
  it("defaults: read enabled, store enabled, default namespace, no threshold override", () => {
    const c = parseCacheControl(fakeReq({}));
    expect(c.bypassRead).toBe(false);
    expect(c.noStore).toBe(false);
    expect(c.namespace).toBe("default");
    expect(c.threshold).toBeNull();
  });

  it("x-cache: bypass skips reads but still stores", () => {
    const c = parseCacheControl(fakeReq({ "x-cache": "bypass" }));
    expect(c.bypassRead).toBe(true);
    expect(c.noStore).toBe(false);
  });

  it("x-cache: no-store may read but won't store", () => {
    const c = parseCacheControl(fakeReq({ "x-cache": "no-store" }));
    expect(c.bypassRead).toBe(false);
    expect(c.noStore).toBe(true);
  });

  it("x-cache: off disables both", () => {
    const c = parseCacheControl(fakeReq({ "x-cache": "off" }));
    expect(c.bypassRead).toBe(true);
    expect(c.noStore).toBe(true);
  });

  it("honors a custom namespace", () => {
    const c = parseCacheControl(fakeReq({ "x-cache-namespace": "tenant-42" }));
    expect(c.namespace).toBe("tenant-42");
  });

  it("parses a valid per-request threshold override", () => {
    const c = parseCacheControl(fakeReq({ "x-similarity-threshold": "0.85" }));
    expect(c.threshold).toBe(0.85);
  });

  it("ignores an out-of-range threshold", () => {
    expect(parseCacheControl(fakeReq({ "x-similarity-threshold": "1.5" })).threshold).toBeNull();
    expect(parseCacheControl(fakeReq({ "x-similarity-threshold": "-1" })).threshold).toBeNull();
    expect(parseCacheControl(fakeReq({ "x-similarity-threshold": "abc" })).threshold).toBeNull();
  });
});
