import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVisitorKey, watchPresence, type PresencePage, type PresenceWatchOptions } from "./presence.js";
import type { TokenStorage } from "./storage.js";
import type { PresenceHeartbeatView, PresencePreview } from "./types.js";

const memory = (): TokenStorage => {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const beat = (data: Partial<PresenceHeartbeatView> = {}) =>
  json({ success: true, data: { enabled: true, intervalSeconds: 15, preview: null, ...data }, error: null });

const reply = (id = "msg_1"): PresencePreview => ({
  messageId: id,
  text: "Hi! Need a hand?",
  senderName: "Ann",
  senderAvatarUrl: null,
});

/** Lets the mocked fetch and the JSON parsing settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("getVisitorKey", () => {
  it("creates one key per browser and project, in the hosted widget's format", () => {
    const storage = memory();
    const key = getVisitorKey("pk_test", storage);
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(getVisitorKey("pk_test", storage)).toBe(key);
    expect(storage.get("reponly:pk_test:visitor")).toBe(key);
    expect(getVisitorKey("pk_other", storage)).not.toBe(key);
  });

  it("replaces a stored value that isn't a valid key", () => {
    const storage = memory();
    storage.set("reponly:pk_test:visitor", "bad key");
    expect(getVisitorKey("pk_test", storage)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("watchPresence", () => {
  let page: PresencePage | null;
  let visible: boolean;
  let storage: TokenStorage;
  let responses: Array<() => Response | Promise<Response>>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    page = { url: "https://site.test/pricing", title: "Pricing", referrer: null };
    visible = true;
    storage = memory();
    responses = [];
    fetchMock = vi.fn(async () => (responses.shift() ?? (() => beat()))());
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const watch = (options: Partial<PresenceWatchOptions> = {}) =>
    watchPresence({
      projectKey: "pk_test",
      baseUrl: "https://reponly.test/",
      storage,
      currentPage: () => page,
      isVisible: () => visible,
      ...options,
    });

  const bodies = () =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

  it("reports the page with the visitor key, then again at the interval the server asks for", async () => {
    responses.push(() => beat({ intervalSeconds: 20 }));
    const watcher = watch();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://reponly.test/api/v1/presence");
    expect(bodies()[0]).toMatchObject({
      projectKey: "pk_test",
      visitorKey: watcher.visitorKey,
      pageUrl: "https://site.test/pricing",
      pageTitle: "Pricing",
      referrer: null,
    });
    expect(watcher.visitorKey).toBe(getVisitorKey("pk_test", storage));

    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("stops for good when live visitors are off for the product", async () => {
    responses.push(() => beat({ enabled: false, intervalSeconds: 0 }));
    watch();
    await settle();
    page = { url: "https://site.test/docs", title: "Docs", referrer: null };
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops when the server rejects the report, and retries slower after a network error", async () => {
    responses.push(() => {
      throw new TypeError("offline");
    });
    const watcher = watch();
    await settle();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    responses.push(() =>
      json({ success: false, data: null, error: { code: "validation_failed", message: "Bad" } }, 400),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("keeps going, slower, when rate limited", async () => {
    responses.push(() =>
      json({ success: false, data: null, error: { code: "rate_limited", message: "Slow down" } }, 429),
    );
    const watcher = watch();
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("reports a new page in single-page apps right away", async () => {
    const watcher = watch();
    await settle();
    page = { url: "https://site.test/docs", title: "Docs", referrer: null };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toMatchObject({ pageUrl: "https://site.test/docs" });
    watcher.stop();
  });

  it("stays quiet while the tab is hidden and reports once it's back", async () => {
    visible = false;
    const watcher = watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    visible = true;
    watcher.refresh();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("hands over an unread agent reply once, until the visitor has seen it", async () => {
    const onPreview = vi.fn();
    responses.push(() => beat({ preview: reply() }), () => beat({ preview: reply() }));
    const watcher = watch({ onPreview });
    await settle();
    expect(onPreview).toHaveBeenCalledWith(reply());

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onPreview).toHaveBeenCalledTimes(1);
    watcher.previewSeen();
    watcher.stop();

    responses.push(() => beat({ preview: reply() }), () => beat({ preview: reply("msg_2") }));
    const later = watch({ onPreview });
    await settle();
    expect(onPreview).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onPreview).toHaveBeenLastCalledWith(reply("msg_2"));
    later.stop();
  });

  it("holds a reply back while it can't be shown, e.g. with the chat open", async () => {
    const onPreview = vi.fn();
    let chatOpen = true;
    responses.push(() => beat({ preview: reply() }), () => beat({ preview: reply() }));
    const watcher = watch({ onPreview, canShowPreview: () => !chatOpen });
    await settle();
    expect(onPreview).not.toHaveBeenCalled();

    chatOpen = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onPreview).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("ignores an answer that arrives after stop", async () => {
    let release: (response: Response) => void = () => undefined;
    responses.push(() => new Promise<Response>((resolve) => (release = resolve)));
    const onPreview = vi.fn();
    const watcher = watch({ onPreview });
    watcher.stop();
    release(beat({ preview: reply() }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onPreview).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
