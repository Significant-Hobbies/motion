import type * as Party from "partykit/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../../protocol/protocol";
import MotionServer from "./server";

type ConnState = { role: "display" | "controller" };

/** Minimal in-memory stand-in for a PartyKit connection. */
class FakeConnection {
  readonly sent: string[] = [];
  state: ConnState | null = null;
  closed: { code?: number; reason?: string } | null = null;
  throwOnSend = false;

  constructor(
    readonly id: string,
    private readonly room: FakeRoom
  ) {}

  send(payload: string): void {
    if (this.throwOnSend) throw new Error("Can't call send() after close()");
    this.sent.push(payload);
  }

  setState(state: ConnState): ConnState {
    this.state = state;
    return state;
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.room.connections.delete(this.id);
  }

  messages(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

class FakeRoom {
  readonly id = "BCDFGH";
  readonly connections = new Map<string, FakeConnection>();

  connect(id: string): FakeConnection {
    const conn = new FakeConnection(id, this);
    this.connections.set(id, conn);
    return conn;
  }

  *getConnections(): IterableIterator<FakeConnection> {
    yield* this.connections.values();
  }
}

function asConn(c: FakeConnection): Party.Connection<ConnState> {
  return c as unknown as Party.Connection<ConnState>;
}

const joints = {
  head: [0.5, 0.2],
  leftHand: [0.3, 0.5],
  rightHand: [0.7, 0.5],
  torso: [0.5, 0.5],
  leftKnee: [0.4, 0.7],
  rightKnee: [0.6, 0.7],
  leftFoot: [0.4, 0.9],
  rightFoot: [0.6, 0.9],
};

function pose(seq: number): string {
  return JSON.stringify({
    v: 1,
    type: "pose",
    seq,
    sentAt: seq,
    quality: 0.9,
    joints,
  });
}

function join(role: string, v: number = PROTOCOL_VERSION): string {
  return JSON.stringify({ v, type: "join", role });
}

describe("MotionServer relay", () => {
  let room: FakeRoom;
  let server: MotionServer;

  function connectAs(id: string, role: "display" | "controller") {
    const conn = room.connect(id);
    server.onConnect(asConn(conn));
    server.onMessage(join(role), asConn(conn));
    return conn;
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    room = new FakeRoom();
    server = new MotionServer(room as unknown as Party.Room);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requires a join before accepting any other message", () => {
    const conn = room.connect("a");
    server.onMessage(
      JSON.stringify({ v: 1, type: "ping", t: 1 }),
      asConn(conn)
    );
    server.onMessage("not json", asConn(conn));
    server.onMessage(new ArrayBuffer(4), asConn(conn));

    expect(conn.messages()).toEqual([
      expect.objectContaining({ type: "error", code: "bad_message" }),
      expect.objectContaining({ type: "error", code: "bad_message" }),
    ]);
    expect(conn.state).toBeNull();
  });

  it("rejects protocol mismatches and unknown roles", () => {
    const old = room.connect("old");
    server.onMessage(join("display", 99), asConn(old));
    expect(old.messages()[0]).toMatchObject({ code: "version_mismatch" });
    expect(old.closed).not.toBeNull();

    const odd = room.connect("odd");
    server.onMessage(join("spectator"), asConn(odd));
    expect(odd.messages()[0]).toMatchObject({ code: "bad_role" });
    expect(odd.closed).not.toBeNull();
  });

  it("broadcasts authoritative presence to both roles", () => {
    const display = connectAs("d", "display");
    expect(display.messages()).toEqual([
      { v: 1, type: "peer", role: "controller", connected: false },
    ]);

    const controller = connectAs("c", "controller");
    expect(display.messages().at(-1)).toEqual({
      v: 1,
      type: "peer",
      role: "controller",
      connected: true,
    });
    expect(controller.messages().at(-1)).toEqual({
      v: 1,
      type: "peer",
      role: "display",
      connected: true,
    });

    server.onClose(asConn(controller));
    room.connections.delete("c");
    expect(display.messages().at(-1)).toMatchObject({
      role: "controller",
      connected: false,
    });
  });

  it("rejects a second display but lets a reconnecting controller win", () => {
    connectAs("d1", "display");
    const second = connectAs("d2", "display");
    expect(second.messages()[0]).toMatchObject({ code: "room_full" });
    expect(second.closed).not.toBeNull();

    const stale = connectAs("c1", "controller");
    const fresh = connectAs("c2", "controller");
    expect(stale.closed).toEqual({
      code: 1000,
      reason: "replaced by a newer connection",
    });
    expect(fresh.state).toEqual({ role: "controller" });
  });

  it("relays each message type only in its allowed direction", () => {
    const display = connectAs("d", "display");
    const controller = connectAs("c", "controller");
    display.sent.length = 0;
    controller.sent.length = 0;

    const status = JSON.stringify({ v: 1, type: "status", state: "ok" });
    const start = JSON.stringify({ v: 1, type: "start" });
    const rec = JSON.stringify({ v: 1, type: "rec", action: "arm" });
    const chunk = JSON.stringify({ v: 1, type: "recchunk", seq: 0 });

    server.onMessage(status, asConn(controller));
    server.onMessage(status, asConn(display)); // wrong direction: dropped
    server.onMessage(start, asConn(display));
    server.onMessage(start, asConn(controller)); // wrong direction: dropped
    server.onMessage(rec, asConn(controller));
    server.onMessage(rec, asConn(display));
    server.onMessage(chunk, asConn(display));
    server.onMessage(chunk, asConn(controller)); // wrong direction: dropped
    server.onMessage(join("display"), asConn(display)); // duplicate join ignored
    server.onMessage(JSON.stringify({ v: 1, type: "future" }), asConn(display));

    expect(display.sent).toEqual([status, rec]);
    expect(controller.sent).toEqual([start, rec, chunk]);
  });

  it("answers ping with pong without relaying it", () => {
    const display = connectAs("d", "display");
    const controller = connectAs("c", "controller");
    display.sent.length = 0;
    controller.sent.length = 0;

    server.onMessage(
      JSON.stringify({ v: 1, type: "ping", t: 42 }),
      asConn(controller)
    );
    server.onMessage(
      JSON.stringify({ v: 1, type: "pong", t: 42 }),
      asConn(controller)
    );

    expect(controller.messages()).toEqual([{ v: 1, type: "pong", t: 42 }]);
    expect(display.sent).toEqual([]);
  });

  it("validates and rate-limits pose packets per controller", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const display = connectAs("d", "display");
    const controller = connectAs("c", "controller");
    display.sent.length = 0;

    server.onMessage(pose(0), asConn(display)); // displays never send pose
    server.onMessage(
      JSON.stringify({ v: 1, type: "pose", seq: 1, joints: {} }),
      asConn(controller)
    );
    expect(display.sent).toEqual([]);

    for (let seq = 1; seq <= 45; seq++) {
      server.onMessage(pose(seq), asConn(controller));
    }
    expect(display.sent).toHaveLength(40);

    vi.setSystemTime(11_000);
    server.onMessage(pose(46), asConn(controller));
    expect(display.sent).toHaveLength(41);
    expect(display.sent.at(-1)).toBe(pose(46));
  });

  it("never lets a send to a closing socket escape the handler", () => {
    const display = connectAs("d", "display");
    const controller = connectAs("c", "controller");
    display.throwOnSend = true;

    expect(() => server.onMessage(pose(1), asConn(controller))).not.toThrow();

    server.onError(asConn(display), new Error("reset"));
    expect(controller.messages().at(-1)).toMatchObject({
      role: "display",
      connected: false,
    });
  });

  it("ignores close/error from connections that never joined", () => {
    const display = connectAs("d", "display");
    const anon = room.connect("anon");
    display.sent.length = 0;

    server.onClose(asConn(anon));
    server.onError(asConn(anon), new Error("reset"));

    expect(display.sent).toEqual([]);
  });
});
