import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenStorage } from "./storage.js";
import { pickTrigger, watchTriggers, type TriggerWatchOptions } from "./triggers.js";
import type { TriggerView } from "./types.js";

const memory = (): TokenStorage => {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
};

const trigger = (overrides: Partial<TriggerView> = {}): TriggerView => ({
  id: "pricing01",
  enabled: true,
  message: "Questions about plans? Just reply.",
  pathContains: "/pricing",
  delaySeconds: 10,
  audience: "everyone",
  ...overrides,
});

describe("pickTrigger", () => {
  const visit = { path: "/pricing?plan=pro", returning: false, isShown: () => false };

  it("matches the path case-insensitively, anywhere in path and query", () => {
    expect(pickTrigger([trigger({ pathContains: "/PRICING" })], visit)?.id).toBe("pricing01");
    expect(pickTrigger([trigger({ pathContains: "plan=pro" })], visit)?.id).toBe("pricing01");
    expect(pickTrigger([trigger()], { ...visit, path: "/docs" })).toBeNull();
  });

  it("treats a missing path as every page", () => {
    expect(pickTrigger([trigger({ pathContains: null })], { ...visit, path: "/" })?.id).toBe("pricing01");
  });

  it("respects the audience", () => {
    const forNew = trigger({ audience: "new" });
    const forReturning = trigger({ audience: "returning" });
    expect(pickTrigger([forNew], visit)).not.toBeNull();
    expect(pickTrigger([forReturning], visit)).toBeNull();
    expect(pickTrigger([forNew], { ...visit, returning: true })).toBeNull();
    expect(pickTrigger([forReturning], { ...visit, returning: true })).not.toBeNull();
  });

  it("skips triggers already shown and disabled ones, taking the first that fits", () => {
    const shown = trigger({ id: "shown01" });
    const off = trigger({ id: "off01", enabled: false });
    const next = trigger({ id: "next01" });
    const picked = pickTrigger([shown, off, next], { ...visit, isShown: (id) => id === "shown01" });
    expect(picked?.id).toBe("next01");
  });
});

describe("watchTriggers", () => {
  let path = "/pricing";
  let storage: TokenStorage;
  let onShow: ReturnType<typeof vi.fn<(t: TriggerView) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    path = "/pricing";
    storage = memory();
    onShow = vi.fn<(t: TriggerView) => void>();
  });
  afterEach(() => vi.useRealTimers());

  const watch = (triggers: TriggerView[], options: Partial<TriggerWatchOptions> = {}) =>
    watchTriggers(triggers, { projectKey: "pk_test", storage, onShow, currentPath: () => path, ...options });

  it("shows a matching trigger after its delay, once per visitor", () => {
    const first = watch([trigger()]);
    vi.advanceTimersByTime(9_999);
    expect(onShow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ id: "pricing01" }));
    first.stop();

    watch([trigger()]);
    vi.advanceTimersByTime(60_000);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("waits for the matching page in single-page apps and cancels when the visitor leaves it", () => {
    path = "/";
    watch([trigger()]);
    vi.advanceTimersByTime(30_000);
    expect(onShow).not.toHaveBeenCalled();

    path = "/pricing";
    vi.advanceTimersByTime(1_000 + 5_000);
    path = "/docs";
    vi.advanceTimersByTime(10_000);
    expect(onShow).not.toHaveBeenCalled();

    path = "/pricing";
    vi.advanceTimersByTime(1_000 + 10_000);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("knows new from returning visitors", () => {
    const returningOnly = trigger({ audience: "returning", pathContains: null, delaySeconds: 0 });
    watch([returningOnly]).stop();
    vi.advanceTimersByTime(1_000);
    expect(onShow).not.toHaveBeenCalled();

    watch([returningOnly]);
    vi.advanceTimersByTime(1_000);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("holds off while the UI can't show one", () => {
    let free = false;
    const watcher = watch([trigger()], { canShow: () => free });
    vi.advanceTimersByTime(30_000);
    expect(onShow).not.toHaveBeenCalled();

    free = true;
    watcher.refresh();
    vi.advanceTimersByTime(10_000);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("hands back the trigger the chat was opened from, then never shows another", () => {
    const watcher = watch([trigger(), trigger({ id: "second01" })]);
    vi.advanceTimersByTime(10_000);
    expect(watcher.chatOpened()?.id).toBe("pricing01");

    path = "/pricing?again";
    vi.advanceTimersByTime(60_000);
    watch([trigger({ id: "third01" })]);
    vi.advanceTimersByTime(60_000);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("returns no trigger when the chat was opened without one", () => {
    const watcher = watch([trigger()]);
    expect(watcher.chatOpened()).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(onShow).not.toHaveBeenCalled();
  });

  it("stops checking once stopped", () => {
    watch([trigger()]).stop();
    vi.advanceTimersByTime(60_000);
    expect(onShow).not.toHaveBeenCalled();
  });
});
