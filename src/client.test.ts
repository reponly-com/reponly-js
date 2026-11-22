import { afterEach, describe, expect, it, vi } from "vitest";
import { ReponlyClient, ReponlyError, type TokenStorage } from "./index.js";

const sharedStorage = (): TokenStorage => {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const session = (token: string) => ({
  success: true,
  data: { customerToken: token, customer: { id: token, kind: "anonymous", name: null } },
  error: null,
});

afterEach(() => vi.unstubAllGlobals());

describe("ReponlyClient", () => {
  it("dedupes concurrent session creation so instances share one visitor identity", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => json(session(`tok-${(calls += 1)}`))));
    const storage = sharedStorage();
    const a = new ReponlyClient({ projectKey: "pk_test", baseUrl: "http://x", storage });
    const b = new ReponlyClient({ projectKey: "pk_test", baseUrl: "http://x", storage });
    const [first, second] = await Promise.all([a.connect(), b.connect()]);
    expect(calls).toBe(1);
    expect(first.id).toBe(second.id);
  });

  it("resumes the stored identity in a later instance", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return json(session("tok-1"));
      }),
    );
    const storage = sharedStorage();
    await new ReponlyClient({ projectKey: "pk_test", baseUrl: "http://x", storage }).connect();
    await new ReponlyClient({ projectKey: "pk_test", baseUrl: "http://x", storage }).connect();
    expect(bodies[1]).toMatchObject({ customerToken: "tok-1" });
  });

  it("surfaces structured rate-limit errors with a retry time", async () => {
    const retryAt = "2026-11-17T12:05:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/sessions")
          ? json(session("tok"))
          : json({ success: false, data: null, error: { code: "rate_limited", message: "slow down", retryAt } }, 429),
      ),
    );
    const client = new ReponlyClient({ projectKey: "pk_test", baseUrl: "http://x", storage: sharedStorage() });
    const error = await client.sendMessage("hi").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReponlyError);
    expect((error as ReponlyError).isRateLimited).toBe(true);
    expect((error as ReponlyError).retryAt?.toISOString()).toBe(retryAt);
  });

  it("reports network failures as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    const client = new ReponlyClient({ projectKey: "pk_test", baseUrl: "http://x", storage: sharedStorage() });
    const error = await client.connect().catch((e: unknown) => e);
    expect((error as ReponlyError).isNetworkError).toBe(true);
  });
});
