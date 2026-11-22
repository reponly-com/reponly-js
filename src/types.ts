/**
 * Wire types of the Reponly customer API (`/api/v1/*`). They mirror the server's types; the
 * Reponly app type-checks itself against them, so a change on either side fails its build.
 */

/** Pusher-protocol (Soketi) connection settings from the project config. */
export type RealtimeClientConfig = {
  key: string;
  wsHost: string;
  wsPort: number;
  forceTLS: boolean;
  channelPrefix: string;
};

export type ApiError = {
  code: string;
  message: string;
  /** ISO timestamp after which a temporarily blocked operation can be retried. */
  retryAt: string | null;
  fields?: Record<string, string[]>;
};

export type ApiResponse<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: ApiError };

export type SenderType = "customer" | "agent" | "system";

/** When to ask a guest for an email, so replies can reach them after they leave. */
export type AskForEmail = "after_first_message" | "before_first_message" | "never";

/** A file sent in chat. Images are shown inline; everything else downloads. */
export type AttachmentView = {
  id: string;
  url: string;
  name: string;
  contentType: string;
  /** Bytes. */
  size: number;
  kind: "image" | "file";
};

/**
 * Where a customer was and what they used when they wrote. Reported by the browser, so it can be
 * wrong or missing; never use it to make access decisions.
 */
export type VisitorContextView = {
  pageUrl: string | null;
  pageTitle: string | null;
  userAgent: string | null;
  /** "Chrome 131" */
  browser: string | null;
  /** "macOS", "iOS 18" */
  os: string | null;
  deviceType: "desktop" | "mobile" | "tablet" | null;
  /** BCP 47, e.g. "en-GB". */
  language: string | null;
  /** Every language the browser prefers, first one first: ["en-GB", "ru", "hy"]. */
  languages: string[] | null;
  /** IANA, e.g. "Europe/Berlin". */
  timezone: string | null;
  /** "1440x900" */
  screen: string | null;
  /** ISO 3166-1 alpha-2 ("DE"). */
  country: string | null;
};

export type ProjectAppearance = {
  /** Brand colour in light mode (and in dark mode when primaryColorDark is null). */
  primaryColor: string;
  primaryColorDark: string | null;
  /** Chat background in light mode; null = the default (white). */
  backgroundColor: string | null;
  /** Chat background in dark mode; null = the default (neutral near-black). */
  backgroundColorDark: string | null;
  logoUrl: string | null;
  welcomeText: string;
  onlineText: string;
  offlineText: string;
};

export type TriggerAudience = "everyone" | "new" | "returning";

/** An automatic message the hosted widget shows on its own: on matching pages, after a delay. */
export type TriggerView = {
  id: string;
  enabled: boolean;
  message: string;
  /** Shown on pages whose path contains this ("/pricing"); null = every page. */
  pathContains: string | null;
  /** Seconds on the page before it shows. */
  delaySeconds: number;
  audience: TriggerAudience;
};

export type MessageView = {
  id: string;
  conversationId: string;
  seq: number;
  senderType: SenderType;
  /** Agent messages: the agent's current name (customers: their name, if known). */
  senderName: string | null;
  /** Agent messages: the agent's profile photo, or null to show initials. */
  senderAvatarUrl: string | null;
  /** May be empty when the message only carries attachments. */
  content: string;
  attachments: AttachmentView[];
  /** Customer messages: the page and device they were sent from. */
  context: VisitorContextView | null;
  clientMessageId: string | null;
  createdAt: string;
};

export type CustomerRealtimeEvent =
  | { type: "message.created"; message: MessageView }
  | { type: "restriction.updated" };

export type PublicProjectConfig = {
  projectKey: string;
  name: string;
  appearance: ProjectAppearance;
  supportOnline: boolean;
  showBranding: boolean;
  /** Live chat is off for this product: collect an email and a message instead. */
  paused: boolean;
  /** When to ask guests for an email (identified customers with an email are never asked). */
  askForEmail: AskForEmail;
  /** File uploads are set up on this server, so the chat can offer attachments. */
  attachments: boolean;
  realtime: RealtimeClientConfig;
  /** Enabled automatic messages (Pro only; empty otherwise). */
  triggers: TriggerView[];
};

export type CustomerSessionView = {
  customerToken: string;
  customer: {
    id: string;
    kind: "anonymous" | "identified";
    name: string | null;
    /** Whether we already have an address to answer this customer by email. */
    hasEmail: boolean;
  };
};

export type CustomerStatusView = {
  restriction: { active: true; permanent: boolean; retryAt: string | null; message: string } | null;
  rateLimit: { retryAt: string; message: string } | null;
};

export type CustomerConversationView = {
  id: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  messageSeq: number;
  /**
   * The newest seq the customer has read, on any device (from markRead). Agent messages
   * after it are unread, so badges agree across browsers.
   */
  customerLastReadSeq: number;
};

/** Private channel of one customer: `private-{prefix}customer.{customerId}`. */
export const customerChannelName = (prefix: string, customerId: string): string =>
  `private-${prefix}customer.${customerId}`;
