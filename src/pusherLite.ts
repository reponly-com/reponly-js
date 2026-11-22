/**
 * Minimal Pusher-protocol (v7) client for Soketi — a few KB instead of pusher-js, so the widget
 * stays light. Supports private channels, ping/pong, activity timeout and reconnect with backoff.
 */
import type { RealtimeClientConfig } from "./types.js";

export type ConnectionState = "connecting" | "connected" | "disconnected";

type ChannelHandlers = {
  onEvent: (event: string, data: unknown) => void;
  onSubscribed?: () => void;
};

type Options = RealtimeClientConfig & {
  /** Returns the `auth` signature for a private channel. */
  authorize: (socketId: string, channel: string) => Promise<string>;
  onStateChange?: (state: ConnectionState) => void;
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
};

type Frame = { event: string; channel?: string; data?: unknown };

const PROTOCOL_VERSION = 7;
const PONG_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

const parseData = (data: unknown): unknown => {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};

export class PusherLite {
  private socket: WebSocket | null = null;
  private socketId: string | null = null;
  private readonly channels = new Map<string, ChannelHandlers>();
  private activityTimeoutMs = 120_000;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;

  constructor(private readonly options: Options) {}

  private get url(): string {
    const { forceTLS, wsHost, wsPort, key } = this.options;
    return `${forceTLS ? "wss" : "ws"}://${wsHost}:${wsPort}/app/${encodeURIComponent(key)}?protocol=${PROTOCOL_VERSION}&client=reponly-js&version=1.0.0&flash=false`;
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.socketId = null;
  }

  subscribe(channel: string, handlers: ChannelHandlers): () => void {
    this.channels.set(channel, handlers);
    if (this.socketId) void this.sendSubscribe(channel);
    return () => {
      this.channels.delete(channel);
      this.send({ event: "pusher:unsubscribe", data: { channel } });
    };
  }

  private open(): void {
    this.options.onStateChange?.("connecting");
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const socket = new Impl(this.url);
    this.socket = socket;
    socket.onmessage = (message) => this.handleFrame(JSON.parse(String(message.data)) as Frame);
    socket.onclose = () => this.handleClose(socket);
    socket.onerror = () => socket.close();
  }

  private handleFrame(frame: Frame): void {
    this.resetActivityTimer();
    const data = parseData(frame.data);
    if (frame.event === "pusher:connection_established") {
      const established = data as { socket_id: string; activity_timeout?: number };
      this.socketId = established.socket_id;
      this.activityTimeoutMs = Math.min((established.activity_timeout ?? 120) * 1000, 120_000);
      this.attempt = 0;
      this.options.onStateChange?.("connected");
      for (const channel of this.channels.keys()) void this.sendSubscribe(channel);
      return;
    }
    if (frame.event === "pusher:ping") return this.send({ event: "pusher:pong", data: {} });
    if (frame.event === "pusher:pong") return this.clearPongTimer();
    if (frame.event === "pusher:error") return this.handleError(data as { code?: number });
    if (!frame.channel) return;
    const handlers = this.channels.get(frame.channel);
    if (!handlers) return;
    if (frame.event === "pusher_internal:subscription_succeeded") handlers.onSubscribed?.();
    else if (frame.event === "pusher:subscription_error") this.retrySubscribe(frame.channel);
    else if (!frame.event.startsWith("pusher")) handlers.onEvent(frame.event, data);
  }

  /** 4000–4099: fatal (bad app key / origin), so stop. Anything else reconnects. */
  private handleError({ code }: { code?: number }): void {
    if (code && code >= 4000 && code < 4100) this.disconnect();
  }

  private async sendSubscribe(channel: string): Promise<void> {
    const socketId = this.socketId;
    if (!socketId) return;
    try {
      const auth = await this.options.authorize(socketId, channel);
      if (this.socketId === socketId && this.channels.has(channel)) {
        this.send({ event: "pusher:subscribe", data: { channel, auth } });
      }
    } catch {
      this.retrySubscribe(channel);
    }
  }

  private retrySubscribe(channel: string): void {
    setTimeout(() => {
      if (this.channels.has(channel)) void this.sendSubscribe(channel);
    }, 5_000);
  }

  private send(frame: Frame): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(frame));
  }

  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.clearTimers();
    this.socket = null;
    this.socketId = null;
    this.options.onStateChange?.("disconnected");
    if (this.stopped) return;
    this.attempt += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt, 5)) * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  /** Server expects traffic within activity_timeout; ping when idle, reconnect if no pong. */
  private resetActivityTimer(): void {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => {
      this.send({ event: "pusher:ping", data: {} });
      this.pongTimer = setTimeout(() => this.socket?.close(), PONG_TIMEOUT_MS);
    }, this.activityTimeoutMs);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearTimers(): void {
    for (const timer of [this.activityTimer, this.pongTimer, this.reconnectTimer]) if (timer) clearTimeout(timer);
    this.activityTimer = this.pongTimer = this.reconnectTimer = null;
  }
}
