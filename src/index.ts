/**
 * Reponly customer SDK — build a custom chat UI or power the hosted widget.
 *
 *   const chat = new ReponlyClient({ projectKey: "pk_...", baseUrl: "https://reponly.com" });
 *   await chat.connect();                       // anonymous visitor (durable id)
 *   await chat.identify(identityTokenFromYourServer); // optional: logged-in customer
 *   const off = chat.subscribe((event) => ...);
 *   await chat.sendMessage("Hi!");             // sends the current page + locale with it
 *   const file = await chat.uploadAttachment(fileInput.files[0]);
 *   await chat.sendMessage("Screenshot", { attachmentIds: [file.id] });
 *   await chat.setContactEmail("me@example.com"); // replies reach them by email after they leave
 *   await chat.markRead(conversationId, lastSeq); // while your chat UI is visible
 */
import type {
  ApiResponse,
  AttachmentView,
  CustomerConversationView,
  CustomerRealtimeEvent,
  CustomerSessionView,
  CustomerStatusView,
  MessageView,
  PublicProjectConfig,
} from "./types.js";
import { customerChannelName } from "./types.js";
import { PusherLite } from "./pusherLite.js";

export type * from "./types.js";
export { customerChannelName } from "./types.js";

export type TokenStorage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

export type ConnectionEvent = { type: "connection"; state: "open" | "reconnecting" };
export type ReponlyEvent = CustomerRealtimeEvent | ConnectionEvent;

export type ReponlyClientOptions = {
  projectKey: string;
  /** Origin of the Reponly app. Defaults to the current origin. */
  baseUrl?: string;
  /** Where the customer token is persisted. Defaults to localStorage when available. */
  storage?: TokenStorage | null;
  /**
   * The widget loader's key for this browser on the site (live visitors). Links the visitor's
   * live presence to their chat, and hands them a conversation an agent started with them.
   */
  visitorKey?: string | null;
};

/** Page and locale sent with each message, so agents know where the customer was. */
export type MessageContext = {
  pageUrl?: string;
  pageTitle?: string;
  /** BCP 47, e.g. "en-GB". */
  language?: string;
  /** Every language the browser prefers, in order. */
  languages?: string[];
  /** IANA, e.g. "Europe/Berlin". */
  timezone?: string;
  /** "1440x900" */
  screen?: string;
};

/** What the browser can tell about the current page and locale. Empty outside a browser. */
export function currentPageContext(): MessageContext {
  if (typeof window === "undefined") return {};
  const context: MessageContext = {
    pageUrl: window.location.href,
    pageTitle: document.title || undefined,
    language: navigator.language || undefined,
    languages: navigator.languages?.length ? navigator.languages.slice(0, 5) : undefined,
    screen: window.screen ? `${window.screen.width}x${window.screen.height}` : undefined,
  };
  try {
    context.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Old browsers without Intl time zones: leave it out.
  }
  return context;
}

export type SendMessageOptions = {
  conversationId?: string;
  /** Idempotency key. Reuse it when retrying the same message. */
  clientMessageId?: string;
  /**
   * Lets the team answer by email. Required when the project's config says `paused: true`
   * and the customer has no email yet (the API answers `email_required`).
   */
  contactEmail?: string;
  /** Ids from uploadAttachment(); a message may be only attachments (empty text). */
  attachmentIds?: string[];
  /**
   * Page and locale to store with the message. Defaults to the current page
   * (currentPageContext()); pass `null` to send none.
   */
  context?: MessageContext | null;
  /**
   * Hosted widget: the automatic message the visitor answered, saved as the chat's greeting.
   * Custom UIs can leave it out.
   */
  triggerId?: string;
};

/** Structured API error. `retryAt` is set for rate limits and temporary restrictions. */
export class ReponlyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAt: Date | null;

  constructor(code: string, message: string, status: number, retryAt: Date | null) {
    super(message);
    this.name = "ReponlyError";
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }

  get isRateLimited(): boolean {
    return this.code === "rate_limited";
  }

  get isRestricted(): boolean {
    return this.code === "customer_restricted";
  }

  /** The project is paused and needs the customer's email before accepting messages. */
  get isEmailRequired(): boolean {
    return this.code === "email_required";
  }

  /** Network failure: safe to retry with the same clientMessageId. */
  get isNetworkError(): boolean {
    return this.code === "network";
  }
}

const memoryStorage = (): TokenStorage => {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
};

function defaultStorage(): TokenStorage {
  try {
    const probe = "__reponly_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return {
      get: (k) => window.localStorage.getItem(k),
      set: (k, v) => window.localStorage.setItem(k, v),
      remove: (k) => window.localStorage.removeItem(k),
    };
  } catch {
    return memoryStorage();
  }
}

export function createClientMessageId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `cm_${random}`;
}

/** Session requests in flight, shared by every client instance for the same project. */
const inflightSessions = new Map<string, Promise<CustomerSessionView>>();

export class ReponlyClient {
  private readonly projectKey: string;
  private readonly baseUrl: string;
  private readonly storage: TokenStorage;
  private token: string | null;
  private customerId: string | null = null;
  private readonly visitorKey: string | null;
  private readonly tokenListeners = new Set<() => void>();

  constructor({ projectKey, baseUrl, storage, visitorKey }: ReponlyClientOptions) {
    this.projectKey = projectKey;
    this.visitorKey = visitorKey ?? null;
    this.baseUrl = (
      baseUrl ?? (typeof window !== "undefined" ? window.location.origin : "")
    ).replace(/\/$/, "");
    this.storage = storage ?? (typeof window !== "undefined" ? defaultStorage() : memoryStorage());
    this.token = this.storage.get(this.tokenKey);
  }

  private get tokenKey(): string {
    return `reponly:${this.projectKey}:token`;
  }

  /** Storage is the source of truth so several tabs/instances converge on one identity. */
  private currentToken(): string | null {
    this.token = this.storage.get(this.tokenKey) ?? this.token;
    return this.token;
  }

  private setToken(token: string | null): void {
    const changed = token !== this.token;
    this.token = token;
    if (token) this.storage.set(this.tokenKey, token);
    else this.storage.remove(this.tokenKey);
    if (changed) for (const listener of this.tokenListeners) listener();
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string") headers.set("Content-Type", "application/json");
    const token = authenticated ? this.currentToken() : null;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new ReponlyError(
        "network",
        "Connection lost. Check your network and try again.",
        0,
        null,
      );
    }
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!payload)
      throw new ReponlyError("internal", "Unexpected server response", response.status, null);
    if (!payload.success) {
      const { code, message, retryAt } = payload.error;
      throw new ReponlyError(code, message, response.status, retryAt ? new Date(retryAt) : null);
    }
    return payload.data;
  }

  /** Calls an authenticated endpoint, transparently re-establishing an expired session once. */
  private async authed<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.currentToken()) await this.connect();
    try {
      return await this.request<T>(path, init);
    } catch (error) {
      if (!(error instanceof ReponlyError) || error.code !== "unauthorized") throw error;
      this.setToken(null);
      await this.connect();
      return this.request<T>(path, init);
    }
  }

  private configPromise: Promise<PublicProjectConfig> | null = null;

  /** Project appearance + realtime settings (cached; retried after a failure). */
  getConfig(): Promise<PublicProjectConfig> {
    this.configPromise ??= this.request<PublicProjectConfig>(
      `/api/v1/projects/${encodeURIComponent(this.projectKey)}/config`,
      {},
      false,
    ).catch((error: unknown) => {
      this.configPromise = null;
      throw error;
    });
    return this.configPromise;
  }

  /** Creates or resumes the visitor session. Optionally identifies a logged-in customer. */
  async connect(
    identityToken?: string,
    resumeToken?: string,
  ): Promise<CustomerSessionView["customer"]> {
    const key = `${this.baseUrl}|${this.tokenKey}|${identityToken ?? ""}|${resumeToken ?? ""}`;
    let pending = inflightSessions.get(key);
    if (!pending) {
      pending = this.request<CustomerSessionView>(
        "/api/v1/sessions",
        {
          method: "POST",
          body: JSON.stringify({
            projectKey: this.projectKey,
            customerToken: this.currentToken(),
            identityToken: identityToken ?? null,
            resumeToken: resumeToken ?? null,
            visitorKey: this.visitorKey,
          }),
        },
        false,
      ).finally(() => inflightSessions.delete(key));
      inflightSessions.set(key, pending);
    }
    const session = await pending;
    this.customerId = session.customer.id;
    this.setToken(session.customerToken);
    return session.customer;
  }

  /** Links the current visitor to a customer from a token signed by your backend. */
  identify(identityToken: string): Promise<CustomerSessionView["customer"]> {
    return this.connect(identityToken);
  }

  /** Forget the stored identity (call when your user logs out). */
  logout(): void {
    this.customerId = null;
    this.setToken(null);
  }

  getStatus(): Promise<CustomerStatusView> {
    return this.authed("/api/v1/status");
  }

  listConversations(): Promise<CustomerConversationView[]> {
    return this.authed("/api/v1/conversations");
  }

  getMessages(conversationId: string, afterSeq = 0): Promise<MessageView[]> {
    return this.authed(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?after=${afterSeq}`,
    );
  }

  sendMessage(
    content: string,
    options: SendMessageOptions = {},
  ): Promise<{ message: MessageView; conversationId: string }> {
    const body = JSON.stringify({
      content,
      clientMessageId: options.clientMessageId ?? createClientMessageId(),
      contactEmail: options.contactEmail,
      attachmentIds: options.attachmentIds,
      triggerId: options.triggerId,
      context:
        options.context === undefined ? currentPageContext() : (options.context ?? undefined),
    });
    const path = options.conversationId
      ? `/api/v1/conversations/${encodeURIComponent(options.conversationId)}/messages`
      : "/api/v1/messages";
    return this.authed(path, { method: "POST", body });
  }

  /**
   * Uploads one file (up to 10 MB: images, PDFs, text, Office files, zips, short videos) for the
   * next message. Send its `id` in `attachmentIds`. Needs the server to have file storage set up
   * (the project config's `attachments` is true).
   */
  async uploadAttachment(file: Blob, name?: string): Promise<AttachmentView> {
    const form = new FormData();
    form.append("file", file, name ?? (file instanceof File ? file.name : "file"));
    return this.authed("/api/v1/attachments", { method: "POST", body: form });
  }

  /** Saves the address replies are emailed to when the customer isn't in the chat. */
  setContactEmail(email: string): Promise<{ hasEmail: true }> {
    return this.authed("/api/v1/contact", { method: "POST", body: JSON.stringify({ email }) });
  }

  /**
   * Tells Reponly the customer has seen messages up to `seq`. Call it while your chat UI is
   * visible: agents see "Seen", and replies already seen aren't emailed.
   */
  markRead(conversationId: string, seq: number): Promise<{ customerLastReadSeq: number }> {
    return this.authed(`/api/v1/conversations/${encodeURIComponent(conversationId)}/read`, {
      method: "POST",
      body: JSON.stringify({ seq }),
    });
  }

  /**
   * Real-time events over the Pusher protocol (Soketi). Emits `{type:"connection", state:"open"}`
   * after every (re)subscribe — refetch messages then, so nothing sent while offline is missed.
   * Follows identity changes (identify/logout) automatically.
   */
  subscribe(handler: (event: ReponlyEvent) => void): () => void {
    let stopped = false;
    let socket: PusherLite | null = null;
    let leaveChannel: () => void = () => undefined;
    let joinedCustomerId: string | null = null;

    const join = (prefix: string) => {
      if (!socket || stopped || joinedCustomerId === this.customerId) return;
      leaveChannel();
      leaveChannel = () => undefined;
      joinedCustomerId = this.customerId;
      if (!joinedCustomerId) return;
      leaveChannel = socket.subscribe(customerChannelName(prefix, joinedCustomerId), {
        onEvent: (_event, data) => handler(data as CustomerRealtimeEvent),
        onSubscribed: () => handler({ type: "connection", state: "open" }),
      });
    };

    let onIdentityChange: () => void = () => undefined;
    const start = async () => {
      const [config] = await Promise.all([this.getConfig(), this.connect()]);
      if (stopped) return;
      socket = new PusherLite({
        ...config.realtime,
        authorize: (socketId, channel) => this.authorizeChannel(socketId, channel),
        onStateChange: (state) =>
          state === "disconnected" && handler({ type: "connection", state: "reconnecting" }),
      });
      onIdentityChange = () => join(config.realtime.channelPrefix);
      this.tokenListeners.add(onIdentityChange);
      join(config.realtime.channelPrefix);
      socket.connect();
    };

    const boot = () =>
      start().catch(() => {
        if (stopped) return;
        handler({ type: "connection", state: "reconnecting" });
        setTimeout(boot, 5_000);
      });
    void boot();

    return () => {
      stopped = true;
      this.tokenListeners.delete(onIdentityChange);
      leaveChannel();
      socket?.disconnect();
    };
  }

  private async authorizeChannel(socketId: string, channel: string): Promise<string> {
    const attempt = () =>
      fetch(`${this.baseUrl}/api/v1/realtime/auth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.currentToken() ?? ""}`,
        },
        body: JSON.stringify({ socket_id: socketId, channel_name: channel }),
      });
    let response = await attempt();
    if (response.status === 401) {
      this.setToken(null);
      await this.connect();
      response = await attempt();
    }
    if (!response.ok)
      throw new ReponlyError(
        "unauthorized",
        "Realtime authorization failed",
        response.status,
        null,
      );
    return ((await response.json()) as { auth: string }).auth;
  }
}
