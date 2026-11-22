/**
 * Live visitors (Pro): tells Reponly which page this visitor is on while the tab is visible, so
 * they show up on the Live page and as "Online now" in the inbox, the same way the hosted widget
 * does. Each answer carries the newest agent reply they haven't read, e.g. one an agent sent from
 * the Live page before they ever opened the chat: show it in a bubble by your chat button.
 *
 *   const visitorKey = getVisitorKey("pk_...");
 *   const chat = new ReponlyClient({ projectKey: "pk_...", baseUrl, visitorKey });
 *   const presence = watchPresence({
 *     projectKey: "pk_...",
 *     baseUrl,
 *     visitorKey,
 *     onPreview: (reply) => showBubble(reply.senderName, reply.text),
 *     canShowPreview: () => !chatIsOpen,
 *   });
 *   // When the visitor dismisses the bubble or opens the chat:
 *   presence.previewSeen();
 */
import { defaultStorage, type TokenStorage } from "./storage.js";
import type { ApiResponse, PresenceHeartbeatView, PresencePreview } from "./types.js";

const VISITOR_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const KEY_LENGTH = 22;
const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_SECONDS = 5;

const storageKey = (projectKey: string, name: string) => `reponly:${projectKey}:${name}`;

function randomKey(): string {
  const bytes = new Uint8Array(KEY_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  // 256 is a multiple of 64, so every character is equally likely.
  return Array.from(bytes, (byte) => KEY_ALPHABET[byte % 64]).join("");
}

/**
 * This browser's key on your site, kept in storage under the same name the hosted widget uses.
 * Pass it to `ReponlyClient` and `watchPresence` so the visit and the chat are the same person.
 */
export function getVisitorKey(projectKey: string, storage: TokenStorage = defaultStorage()): string {
  const name = storageKey(projectKey, "visitor");
  const existing = storage.get(name);
  if (existing && VISITOR_KEY.test(existing)) return existing;
  const key = randomKey();
  storage.set(name, key);
  return key;
}

/** The page being reported. */
export type PresencePage = {
  url: string;
  title: string | null;
  referrer: string | null;
};

export type PresenceWatchOptions = {
  projectKey: string;
  /** Origin of the Reponly app. Defaults to the current origin. */
  baseUrl?: string;
  /** Defaults to `getVisitorKey(projectKey, storage)`. */
  visitorKey?: string;
  /** Where the visitor key and the last seen reply are kept. Defaults to localStorage. */
  storage?: TokenStorage | null;
  /** An agent reply the visitor hasn't read: show it by your closed chat. Called once per reply. */
  onPreview?: (preview: PresencePreview) => void;
  /** Return false while a reply shouldn't pop up (chat open, button hidden). */
  canShowPreview?: () => boolean;
  /** Defaults to `location.href`, `document.title` and `document.referrer`. */
  currentPage?: () => PresencePage | null;
  /** Defaults to `document.visibilityState === "visible"`. */
  isVisible?: () => boolean;
  /** How often to check for client-side navigation, in ms. Defaults to 1000. */
  pollMs?: number;
};

export type PresenceWatcher = {
  visitorKey: string;
  /** The visitor saw the reply handed to `onPreview` (dismissed it or opened the chat). */
  previewSeen(): void;
  /** Report now, e.g. after the tab became visible in an environment without `document`. */
  refresh(): void;
  /** Stop reporting. */
  stop(): void;
};

const browserPage = (): PresencePage | null =>
  typeof window === "undefined" || typeof document === "undefined"
    ? null
    : { url: window.location.href, title: document.title || null, referrer: document.referrer || null };

const documentVisible = () =>
  typeof document === "undefined" || document.visibilityState === "visible";

const browserTimezone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

type BeatResult = { kind: "ok"; view: PresenceHeartbeatView } | { kind: "retry" } | { kind: "stop" };

/** Reports this visitor's page to Reponly while the tab is visible; see the module comment. */
export function watchPresence(options: PresenceWatchOptions): PresenceWatcher {
  const storage = options.storage ?? defaultStorage();
  const visitorKey = options.visitorKey ?? getVisitorKey(options.projectKey, storage);
  const baseUrl = (options.baseUrl ?? (typeof window !== "undefined" ? window.location.origin : "")).replace(
    /\/$/,
    "",
  );
  const readPage = options.currentPage ?? browserPage;
  const isVisible = options.isVisible ?? documentVisible;
  const canShowPreview = options.canShowPreview ?? (() => true);
  const seenKey = storageKey(options.projectKey, "seen-preview");
  const timezone = browserTimezone();

  let intervalMs = DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reportedUrl: string | null = null;
  let shownPreview: string | null = null;
  let latestBeat = 0;
  let stopped = false;

  async function send(page: PresencePage): Promise<BeatResult> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/v1/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          projectKey: options.projectKey,
          visitorKey,
          pageUrl: page.url,
          pageTitle: page.title,
          referrer: page.referrer,
          timezone,
        }),
      });
    } catch {
      return { kind: "retry" };
    }
    const payload = (await response.json().catch(() => null)) as ApiResponse<PresenceHeartbeatView> | null;
    if (!payload || response.status === 429 || response.status >= 500) return { kind: "retry" };
    if (!payload.success || !payload.data.enabled) return { kind: "stop" };
    return { kind: "ok", view: payload.data };
  }

  function showPreview(preview: PresencePreview | null): void {
    if (!preview || !canShowPreview()) return;
    if (preview.messageId === shownPreview || preview.messageId === storage.get(seenKey)) return;
    shownPreview = preview.messageId;
    options.onPreview?.(preview);
  }

  function beat(): void {
    clearTimeout(timer);
    if (stopped || !isVisible()) return;
    const page = readPage();
    if (!page) return;
    reportedUrl = page.url;
    const run = (latestBeat += 1);
    void send(page).then((result) => {
      if (stopped || run !== latestBeat) return;
      if (result.kind === "stop") return stop();
      if (result.kind === "retry") {
        timer = setTimeout(beat, intervalMs * 2);
        return;
      }
      intervalMs = Math.max(MIN_INTERVAL_SECONDS, result.view.intervalSeconds) * 1000;
      showPreview(result.view.preview);
      timer = setTimeout(beat, intervalMs);
    });
  }

  // Single-page apps change the URL without reloading: report the new page right away.
  const poll = setInterval(() => {
    if (isVisible() && readPage()?.url !== reportedUrl) beat();
  }, options.pollMs ?? 1000);

  const onVisibility = () => {
    if (isVisible()) beat();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  function stop(): void {
    stopped = true;
    clearTimeout(timer);
    clearInterval(poll);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  }

  beat();
  return {
    visitorKey,
    previewSeen() {
      if (shownPreview) storage.set(seenKey, shownPreview);
      shownPreview = null;
    },
    refresh: beat,
    stop,
  };
}
