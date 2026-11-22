import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReponlyClient, type ReponlyEvent, type TokenStorage } from "./index.js";
import { PusherLite } from "./pusherLite.js";

type Frame = { event: string; channel?: string; data?: unknown };

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: Frame[] = [];
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Frame);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(frame: Frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  established(socketId = "1.1") {
    this.emit({ event: "pusher:connection_established", data: JSON.stringify({ socket_id: socketId, activity_timeout: 120 }) });
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];
const realtime = { key: "k", wsHost: "localhost", wsPort: 6002, forceTLS: false, channelPrefix: "" };

beforeEach(() => {
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PusherLite", () => {
  const create = (authorize = vi.fn(async () => "k:sig")) => {
    const lite = new PusherLite({ ...realtime, authorize, WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
    return { lite, authorize };
  };

  it("connects with the Pusher v7 URL and subscribes to private channels with auth", async () => {
    const { lite, authorize } = create();
    const events: unknown[] = [];
    lite.subscribe("private-customer.1", { onEvent: (event, data) => events.push({ event, data }) });
    lite.connect();
    expect(latest().url).toBe("ws://localhost:6002/app/k?protocol=7&client=reponly-js&version=1.0.0&flash=false");
    latest().established("42.7");
    await vi.waitFor(() => expect(latest().sent).toContainEqual({ event: "pusher:subscribe", data: { channel: "private-customer.1", auth: "k:sig" } }));
    expect(authorize).toHaveBeenCalledWith("42.7", "private-customer.1");

    latest().emit({ event: "message.created", channel: "private-customer.1", data: JSON.stringify({ type: "message.created" }) });
    latest().emit({ event: "message.created", channel: "private-other.1", data: "{}" });
    expect(events).toEqual([{ event: "message.created", data: { type: "message.created" } }]);
  });

  it("answers pings and reports subscription success", () => {
    const { lite } = create();
    const onSubscribed = vi.fn();
    lite.subscribe("private-org.1", { onEvent: () => undefined, onSubscribed });
    lite.connect();
    latest().established();
    latest().emit({ event: "pusher:ping", data: "{}" });
    latest().emit({ event: "pusher_internal:subscription_succeeded", channel: "private-org.1", data: "{}" });
    expect(latest().sent).toContainEqual({ event: "pusher:pong", data: {} });
    expect(onSubscribed).toHaveBeenCalledOnce();
  });

  it("reconnects after the socket drops and resubscribes", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    const { lite } = create();
    lite.subscribe("private-org.1", { onEvent: () => undefined });
    lite.connect();
    latest().established();
    latest().close();
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.instances).toHaveLength(2);
    latest().established("2.2");
    await vi.advanceTimersByTimeAsync(0);
    expect(latest().sent.some((f) => f.event === "pusher:subscribe")).toBe(true);
  });

  it("stops on fatal 40xx errors and on disconnect()", async () => {
    vi.useFakeTimers();
    const { lite } = create();
    lite.connect();
    latest().emit({ event: "pusher:error", data: JSON.stringify({ code: 4001, message: "App key not in this cluster" }) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("pings when idle and reconnects if no pong arrives", async () => {
    vi.useFakeTimers();
    const { lite } = create();
    lite.connect();
    latest().established();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(latest().sent).toContainEqual({ event: "pusher:ping", data: {} });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(latest().readyState).toBe(3);
  });
});

describe("ReponlyClient.subscribe", () => {
  const storage = (): TokenStorage => {
    const map = new Map<string, string>();
    return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
  };
  const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data, error: null }));

  it("joins the customer's channel and switches channels when the identity changes", async () => {
    let customer = "a".repeat(24);
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/config")) return ok({ realtime });
        if (url.endsWith("/sessions")) return ok({ customerToken: `tok-${customer}`, customer: { id: customer, kind: "anonymous", name: null } });
        if (url.endsWith("/realtime/auth")) return new Response(JSON.stringify({ auth: "k:sig" }));
        return ok([]);
      }),
    );
    const client = new ReponlyClient({ projectKey: "pk_rt", baseUrl: "http://x", storage: storage() });
    const events: ReponlyEvent[] = [];
    const off = client.subscribe((event) => events.push(event));
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    latest().established();
    await vi.waitFor(() =>
      expect(latest().sent).toContainEqual({ event: "pusher:subscribe", data: { channel: `private-customer.${"a".repeat(24)}`, auth: "k:sig" } }),
    );
    latest().emit({ event: "pusher_internal:subscription_succeeded", channel: `private-customer.${"a".repeat(24)}` });
    latest().emit({ event: "restriction.updated", channel: `private-customer.${"a".repeat(24)}`, data: '{"type":"restriction.updated"}' });
    expect(events).toEqual([{ type: "connection", state: "open" }, { type: "restriction.updated" }]);

    customer = "b".repeat(24);
    await client.identify("identity-token");
    await vi.waitFor(() =>
      expect(latest().sent).toContainEqual({ event: "pusher:subscribe", data: { channel: `private-customer.${"b".repeat(24)}`, auth: "k:sig" } }),
    );
    expect(latest().sent).toContainEqual({ event: "pusher:unsubscribe", data: { channel: `private-customer.${"a".repeat(24)}` } });
    off();
    expect(latest().readyState).toBe(3);
  });
  it("reuses the session from connect() instead of creating a second one", async () => {
    const customer = "c".repeat(24);
    vi.stubGlobal("WebSocket", FakeSocket);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/config")) return ok({ realtime });
      if (url.endsWith("/sessions")) return ok({ customerToken: "tok-c", customer: { id: customer, kind: "identified", name: null } });
      if (url.endsWith("/realtime/auth")) return new Response(JSON.stringify({ auth: "k:sig" }));
      return ok([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ReponlyClient({ projectKey: "pk_reuse", baseUrl: "http://x", storage: storage() });

    await client.connect("identity-token");
    const off = client.subscribe(() => undefined);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    latest().established();
    await vi.waitFor(() =>
      expect(latest().sent).toContainEqual({ event: "pusher:subscribe", data: { channel: `private-customer.${customer}`, auth: "k:sig" } }),
    );

    const sessionCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sessions"));
    expect(sessionCalls).toHaveLength(1);
    off();
  });
});
