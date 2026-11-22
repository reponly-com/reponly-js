/**
 * Automatic messages (Pro): `config.triggers`, shown by your UI with the same rules as the
 * hosted widget — after `delaySeconds` on a page whose path contains `pathContains`, to the
 * right audience, at most once per visitor each, and never again once they've opened the chat.
 *
 *   const watcher = watchTriggers(config.triggers, {
 *     projectKey: "pk_...",
 *     onShow: (trigger) => showBubble(trigger.message),
 *     canShow: () => !chatIsOpen,
 *   });
 *   // When the visitor opens your chat (from the bubble or not):
 *   const trigger = watcher.chatOpened(); // show trigger.message at the top instead of the welcome
 *   await chat.sendMessage(text, { triggerId: trigger?.id, welcomeShown: true });
 */
import { defaultStorage, type TokenStorage } from "./storage.js";
import type { TriggerView } from "./types.js";

/** Where the visitor is and what they've already seen. */
export type TriggerVisit = {
  /** Path and query of the current page, e.g. "/pricing?plan=pro". */
  path: string;
  /** They had visited this site before. */
  returning: boolean;
  /** This trigger was already shown to them. */
  isShown: (triggerId: string) => boolean;
};

/** The first enabled trigger that fits this page and visitor and wasn't shown yet. */
export function pickTrigger(triggers: TriggerView[], visit: TriggerVisit): TriggerView | null {
  const path = visit.path.toLowerCase();
  return (
    triggers.find(
      (t) =>
        t.enabled !== false &&
        !visit.isShown(t.id) &&
        (!t.pathContains || path.includes(t.pathContains.toLowerCase())) &&
        (t.audience === "everyone" || (t.audience === "returning") === visit.returning),
    ) ?? null
  );
}

export type TriggerWatchOptions = {
  projectKey: string;
  /** The trigger's delay has passed on a matching page: show `trigger.message`, e.g. in a bubble. */
  onShow: (trigger: TriggerView) => void;
  /**
   * Return false while you can't show one (chat open, launcher hidden, a bubble already up).
   * Checked when a trigger is scheduled and again when its delay ends; call `refresh()` once
   * it turns true.
   */
  canShow?: () => boolean;
  /** Where "seen", "opened" and shown triggers are kept. Defaults to localStorage. */
  storage?: TokenStorage | null;
  /** Path and query of the current page. Defaults to `location.pathname + location.search`. */
  currentPath?: () => string;
  /** How often to check for client-side navigation, in ms. Defaults to 1000. */
  pollMs?: number;
};

export type TriggerWatcher = {
  /**
   * Call when the visitor opens your chat, whether from the bubble or not. No trigger is shown
   * after that, on this or any later visit. Returns the trigger last shown to them: show its
   * message above the chat and send its `id` as `triggerId` with the first message.
   */
  chatOpened(): TriggerView | null;
  /** Check again now, e.g. after `canShow()` became true. */
  refresh(): void;
  /** Stop timers and navigation checks. */
  stop(): void;
};

const browserPath = () =>
  typeof window === "undefined" ? null : `${window.location.pathname}${window.location.search}`;

/** Shows `config.triggers` at the right moments; see the module comment for the rules. */
export function watchTriggers(triggers: TriggerView[], options: TriggerWatchOptions): TriggerWatcher {
  const storage = options.storage ?? defaultStorage();
  const key = (name: string) => `reponly:${options.projectKey}:${name}`;
  const readPath = options.currentPath ?? browserPath;
  const canShow = options.canShow ?? (() => true);

  const returning = storage.get(key("seen")) !== null;
  storage.set(key("seen"), "1");

  let lastShown: TriggerView | null = null;
  let scheduledPath: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const opened = () => storage.get(key("opened")) !== null;
  const blocked = () => stopped || opened() || !canShow();

  function schedule(): void {
    clearTimeout(timer);
    const path = readPath();
    scheduledPath = path;
    if (path === null || blocked()) return;
    const next = pickTrigger(triggers, {
      path,
      returning,
      isShown: (id) => storage.get(key(`trigger:${id}`)) !== null,
    });
    if (!next) return;
    timer = setTimeout(() => {
      if (blocked() || readPath() !== path) return;
      storage.set(key(`trigger:${next.id}`), "1");
      lastShown = next;
      options.onShow(next);
    }, next.delaySeconds * 1000);
  }

  const poll = setInterval(() => {
    if (readPath() !== scheduledPath) schedule();
  }, options.pollMs ?? 1000);

  function stop(): void {
    stopped = true;
    clearTimeout(timer);
    clearInterval(poll);
  }

  schedule();
  return {
    chatOpened() {
      storage.set(key("opened"), "1");
      stop();
      return lastShown;
    },
    refresh: schedule,
    stop,
  };
}
