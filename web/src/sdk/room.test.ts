import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Room } from "./room";

const transport = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("partysocket", () => ({
  PartySocket: vi.fn(function createSocket(options: unknown) {
    return transport.create(options);
  }),
}));

/** Emits only explicit test events; never opens a network connection. */
class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount: number | undefined = 0;
  readonly sent: unknown[] = [];
  readonly close = vi.fn(() => this.transition("close", 3));

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }

  transition(event: "open" | "close" | "error", state: number): void {
    this.readyState = state;
    this.dispatchEvent(new Event(event));
  }

  receive(message: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(message) })
    );
  }
}

describe("Room connection lifecycle", () => {
  let socket: FakeSocket;
  let room: Room;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    vi.spyOn(performance, "now").mockReturnValue(100);
    socket = new FakeSocket();
    transport.create.mockReturnValue(socket);
    room = new Room("wss://relay.invalid/", "BCDFGH");
  });

  afterEach(() => {
    room.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    transport.create.mockReset();
  });

  it("joins the stable display room and pings immediately then every two seconds", () => {
    expect(transport.create).toHaveBeenCalledWith({
      host: "relay.invalid",
      room: "BCDFGH",
    });
    expect(room.code).toBe("BCDFGH");
    expect(room.connectionState).toBe("connecting");
    expect(room.isOpen).toBe(false);
    expect(socket.sent).toEqual([]);

    const connected = vi.fn();
    room.on("conn", connected);
    socket.transition("open", 1);

    expect(connected).toHaveBeenCalledWith("open");
    expect(room.connectionState).toBe("open");
    expect(room.isOpen).toBe(true);
    expect(socket.sent).toEqual([
      { v: 1, type: "join", role: "display" },
      { v: 1, type: "ping", t: 100 },
    ]);
    vi.advanceTimersByTime(1999);
    expect(socket.sent).toHaveLength(2);
    vi.mocked(performance.now).mockReturnValue(2100);
    vi.advanceTimersByTime(1);
    expect(socket.sent.at(-1)).toEqual({ v: 1, type: "ping", t: 2100 });
  });

  it("stops on close and rejoins on reconnect with exactly one ping loop", () => {
    const states: string[] = [];
    const unsubscribe = room.on("conn", (state) => states.push(state));
    socket.transition("open", 1);
    socket.transition("close", 3);
    expect(room.connectionState).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(6000);
    expect(socket.sent).toHaveLength(2);

    socket.transition("error", 0);
    expect(room.connectionState).toBe("connecting");
    socket.transition("open", 1);
    // A repeated open event must replace the interval rather than duplicate it.
    socket.transition("open", 1);
    expect(vi.getTimerCount()).toBe(1);
    expect(
      socket.sent.filter((msg) => (msg as { type: string }).type === "join")
    ).toHaveLength(3);
    const beforeTick = socket.sent.length;
    vi.advanceTimersByTime(2000);
    expect(socket.sent).toHaveLength(beforeTick + 1);
    expect(states).toEqual(["open", "closed", "connecting", "open", "open"]);
    unsubscribe();
    room.close();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(states).toHaveLength(5);
    expect(room.connectionState).toBe("closed");
    vi.advanceTimersByTime(6000);
    expect(socket.sent).toHaveLength(beforeTick + 1);
  });

  it("requires a fresh controller presence snapshot after disconnect", () => {
    const presenceAtChange: boolean[] = [];
    room.on("conn", () => presenceAtChange.push(room.peerConnected));
    socket.transition("open", 1);
    socket.receive({ v: 1, type: "peer", role: "controller", connected: true });
    expect(room.peerConnected).toBe(true);

    socket.transition("close", 3);
    expect(room.peerConnected).toBe(false);
    socket.transition("open", 1);
    expect(room.peerConnected).toBe(false);
    socket.receive({ v: 1, type: "peer", role: "controller", connected: true });
    expect(room.peerConnected).toBe(true);

    socket.transition("error", 0);
    expect(room.peerConnected).toBe(false);
    expect(presenceAtChange).toEqual([false, false, false, false]);
  });

  it("forwards valid relay events but rejects malformed pose input", () => {
    const poses = vi.fn();
    const statuses = vi.fn();
    const calibrations = vi.fn();
    const peers = vi.fn();
    const errors = vi.fn();
    const stopPoses = room.on("pose", poses);
    room.on("status", statuses);
    room.on("calib", calibrations);
    room.on("peer", peers);
    room.on("error", errors);

    socket.receive({ v: 1, type: "pose", seq: 1, joints: {} });
    expect(poses).not.toHaveBeenCalled();
    expect(room.lastPose).toBeNull();

    const pose = {
      v: 1,
      type: "pose",
      seq: 2,
      sentAt: 10,
      quality: 0.9,
      joints: {
        head: [0.5, 0.2],
        torso: [0.5, 0.5],
        leftHand: [0.3, 0.5],
        rightHand: [0.7, 0.5],
        leftKnee: [0.4, 0.7],
        rightKnee: [0.6, 0.7],
        leftFoot: [0.4, 0.9],
        rightFoot: [0.6, 0.9],
      },
    };
    socket.receive(pose);
    expect(poses).toHaveBeenCalledWith(pose);
    expect(room.lastPose).toEqual(pose);
    stopPoses();
    socket.receive({ ...pose, seq: 3 });
    expect(poses).toHaveBeenCalledOnce();

    const status = { v: 1, type: "status", tracking: "ok" };
    const calib = { v: 1, type: "calib", stage: "done", progress: 1 };
    const error = { v: 1, type: "error", code: "room_full", message: "Full" };
    socket.receive(status);
    socket.receive(calib);
    socket.receive({ v: 1, type: "peer", role: "display", connected: true });
    expect(room.peerConnected).toBe(false);
    socket.receive({ v: 1, type: "peer", role: "controller", connected: true });
    socket.receive({ v: 1, type: "pong", t: 20 });
    socket.receive(error);
    expect(statuses).toHaveBeenCalledWith(status);
    expect(calibrations).toHaveBeenCalledWith(calib);
    expect(peers).toHaveBeenCalledTimes(2);
    expect(room.peerConnected).toBe(true);
    expect(room.rtt).toBe(80);
    expect(errors).toHaveBeenCalledWith(error);
  });

  it("sends start and recording control only while open and exposes backpressure", () => {
    const recording = {
      v: 1,
      type: "rec",
      action: "arm",
      sessionId: "fixture-session",
      anchorMs: 100,
    } as const;
    room.start();
    room.sendRec(recording);
    expect(socket.sent).toEqual([]);
    socket.bufferedAmount = undefined;
    expect(room.bufferedAmount).toBe(0);

    socket.transition("open", 1);
    socket.bufferedAmount = 4096;
    expect(room.bufferedAmount).toBe(4096);
    room.start();
    room.sendRec(recording);
    expect(socket.sent.slice(2)).toEqual([{ v: 1, type: "start" }, recording]);
    room.close();
    expect(room.isOpen).toBe(false);
    room.start();
    room.sendRec(recording);
    expect(socket.sent).toHaveLength(4);
  });
});
