import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSession,
  type GameHost,
  type SessionOptions,
  type SessionScreenRenderer,
} from "./index";
import type { Game } from "./game";
import type { PosePacket } from "../../../protocol/protocol";
import type { RecorderOptions } from "./recording";

const doubles = vi.hoisted(() => ({
  socket: vi.fn(),
  recorder: vi.fn(),
  camera: vi.fn(),
}));
vi.mock("partysocket", () => ({
  PartySocket: vi.fn(function createSocket(options) {
    return doubles.socket(options);
  }),
}));
vi.mock("./recording", async (original) => ({
  ...(await original<typeof import("./recording")>()),
  CanvasRecorder: Object.assign(
    vi.fn(function createRecorder(options) {
      return doubles.recorder(options);
    }),
    { supported: true }
  ),
}));
vi.mock("./webcam", () => ({
  WebcamController: vi.fn(function createCamera() {
    return doubles.camera();
  }),
}));

class Socket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  readonly close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(message: object) {
    this.dispatchEvent(
      Object.assign(new Event("message"), { data: JSON.stringify(message) })
    );
  }
}

describe("socket and camera session routing", () => {
  let host: GameHost | undefined;
  let socket: Socket;
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let seq: number;
  let win: EventTarget;
  let canvas: EventTarget & {
    getContext: () => object;
    getBoundingClientRect: () => object;
    style: object;
  };
  let screens: SessionScreenRenderer;
  let game: Game;
  let recording: {
    phase: string;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    needsMp4Warning: boolean;
    downloadUrl: string;
  };
  let overlay: {
    childElementCount: number;
    appendChild: (element: object) => void;
  };
  let onPhase: NonNullable<RecorderOptions["onPhase"]>;

  function packet(quality = 1): PosePacket {
    return {
      v: 1,
      type: "pose",
      seq: ++seq,
      sentAt: now,
      quality,
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
  }

  function frame(delta = 20, quality?: number) {
    if (quality !== undefined) socket.receive(packet(quality));
    now += delta;
    vi.mocked(performance.now).mockReturnValue(now);
    expect(frames.size).toBe(1);
    const [id, callback] = [...frames.entries()][0]!;
    frames.delete(id);
    callback(now);
  }

  function mount(options: Partial<SessionOptions> = {}) {
    host = createSession({
      game,
      screens,
      mount: {
        canvas: canvas as unknown as HTMLCanvasElement,
        overlay: overlay as unknown as HTMLElement,
      },
      options: {
        partyHost: "https://relay.invalid/",
        forcedRoom: "BCDFGH",
        ...options,
      },
    });
    return host;
  }

  function reachReadiness() {
    socket.open();
    socket.receive({ v: 1, type: "peer", role: "controller", connected: true });
    frame(20, 1); // pairing -> mirror
    for (let i = 0; i < 102; i++) frame(20, 1);
    expect(screens.readiness).toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    now = 0;
    seq = 0;
    frames = new Map();
    socket = new Socket();
    doubles.socket.mockReturnValue(socket);
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) =>
      frames.delete(frameId)
    );
    win = Object.assign(new EventTarget(), {
      innerWidth: 1440,
      innerHeight: 900,
      devicePixelRatio: 1,
      setInterval,
    });
    vi.stubGlobal("window", win);
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const element = () => ({ style: {}, textContent: "", remove: vi.fn() });
    vi.stubGlobal("document", { createElement: element });
    const context = Object.fromEntries(
      [
        "setTransform",
        "fillRect",
        "save",
        "restore",
        "fillText",
        "beginPath",
        "moveTo",
        "lineTo",
        "stroke",
        "arc",
        "fill",
      ].map((key) => [key, vi.fn()])
    );
    context.measureText = vi.fn(() => ({ width: 200 }));
    canvas = Object.assign(new EventTarget(), {
      style: {},
      getContext: () => context,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 1440,
        height: 900,
      }),
    });
    overlay = { childElementCount: 0, appendChild: vi.fn() };
    screens = {
      clear: vi.fn(),
      pairing: vi.fn(),
      mirror: vi.fn(),
      readiness: vi.fn(),
      trackingLost: vi.fn(),
      reconnecting: vi.fn(),
      results: vi.fn(),
    };
    game = {
      id: "fixture",
      name: "Fixture",
      durationMs: 1000,
      init: vi.fn(),
      update: vi.fn(),
      render: vi.fn(),
      isOver: vi.fn(() => false),
      result: vi.fn(() => ({ score: 9, stats: [] })),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
    recording = {
      phase: "idle",
      needsMp4Warning: true,
      downloadUrl: "blob:fixture",
      start: vi.fn(() => {
        recording.phase = "recording";
        onPhase("recording");
      }),
      stop: vi.fn(() => {
        recording.phase = "transferring";
        onPhase("transferring");
      }),
      dispose: vi.fn(),
    };
    doubles.recorder.mockImplementation((options: RecorderOptions) => {
      onPhase = options.onPhase!;
      return recording;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    host?.dispose();
    host = undefined;
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    doubles.socket.mockReset();
    doubles.recorder.mockReset();
    doubles.camera.mockReset();
  });

  it("routes validated poses through continuous mirror/readiness holds, calibration and peer loss, then brackets results and replay", () => {
    const session = mount();
    const events = vi.fn();
    session.on("recording", events);
    frame();
    const pairing = vi.mocked(screens.pairing).mock.calls[0]![0];
    expect(pairing).toMatchObject({
      code: "BCDFGH",
      conn: "connecting",
      debug: false,
      recordOn: false,
    });
    pairing.onToggleRecord(true);
    expect(session.recording).toBe(true);
    expect(session.recorderNeedsMp4Warning).toBe(true);
    expect(session.lastClipUrl).toBe("blob:fixture");
    socket.receive({ v: 1, type: "pose", joints: {} });
    frame();
    expect(game.init).not.toHaveBeenCalled();
    reachReadiness();
    socket.receive({
      v: 1,
      type: "peer",
      role: "controller",
      connected: false,
    });
    frame(20, 1);
    expect(screens.pairing).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordOn: true })
    );
    reachReadiness();
    for (let i = 0; i < 80; i++) frame(20, 1);
    expect(game.init).not.toHaveBeenCalled(); // calibration still required
    socket.receive({ v: 1, type: "calib", stage: "done" });
    frame(20, 1);
    expect(game.init).toHaveBeenCalledOnce();
    expect(recording.start).toHaveBeenCalledOnce();
    expect(events).toHaveBeenCalledWith("recording", undefined);
    expect(session.recordingPhase).toBe("recording");
    expect(
      socket.sent.filter((message) => message.type === "start")
    ).toHaveLength(1);
    socket.close();
    frame(20, 1);
    expect(screens.reconnecting).toHaveBeenCalledOnce();
    frame(500);
    const updates = vi.mocked(game.update).mock.calls.length;
    expect(screens.trackingLost).toHaveBeenCalled();
    frame();
    expect(vi.mocked(game.update).mock.calls).toHaveLength(updates);
    socket.open();
    overlay.childElementCount = 1;
    frame(20, 1);
    expect(vi.mocked(game.update).mock.calls.length).toBeGreaterThan(updates);
    expect(screens.clear).toHaveBeenCalled();
    overlay.childElementCount = 0;
    vi.mocked(game.isOver).mockReturnValue(true);
    frame(20, 1);
    expect(recording.stop).toHaveBeenCalledOnce();
    expect(session.recordingPhase).toBe("transferring");
    vi.mocked(screens.results).mock.calls[0]![1]();
    expect(game.reset).toHaveBeenCalledOnce();
    session.dispose();
    host = undefined;
    expect(recording.dispose).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledTimes(2);
  });

  it("resets the mirror stability window on poor tracking before admitting readiness", () => {
    mount();
    socket.open();
    frame(20, 1);
    for (let i = 0; i < 80; i++) frame(20, 1);
    frame(20, 0);
    for (let i = 0; i < 80; i++) frame(20, 1);
    expect(screens.readiness).not.toHaveBeenCalled();
    for (let i = 0; i < 25; i++) frame(20, 1);
    expect(screens.readiness).toHaveBeenCalled();
    expect(game.init).not.toHaveBeenCalled();
  });

  it("switches debug input without reconnecting and releases the previous controller", () => {
    const session = mount({ skipReadiness: true });
    const live = session.controller;
    const key = (repeat = false) =>
      win.dispatchEvent(
        Object.assign(new Event("keydown"), { key: "d", repeat })
      );
    key(true);
    expect(session.controller).toBe(live);
    key();
    const debug = session.controller;
    expect(debug).not.toBe(live);
    canvas.dispatchEvent(
      Object.assign(new Event("mousemove"), { clientX: 700, clientY: 450 })
    );
    frame();
    expect(game.init).toHaveBeenCalledOnce();
    key();
    expect(session.controller).toBe(live);
    canvas.dispatchEvent(
      Object.assign(new Event("mousemove"), { clientX: 0, clientY: 0 })
    );
    for (let i = 1; i <= 120; i++) debug.tick(20 + i * 20);
    expect(debug.joints.leftHand[0]).toBeCloseTo(700 / 1440 - 0.12);
    expect(debug.joints.leftHand[1]).toBeCloseTo(0.5);
    expect(doubles.socket).toHaveBeenCalledOnce();
  });

  it("routes camera input without constructing a room or recorder and disposes it even in debug mode", () => {
    // Only camera orchestration is doubled here; actual startup/cleanup is tested in webcam.test.ts.
    const camera = { health: "no_signal", tick: vi.fn(), dispose: vi.fn() };
    doubles.camera.mockReturnValue(camera);
    const session = mount({ camera: true, skipReadiness: true, record: true });
    frame();
    expect(game.init).not.toHaveBeenCalled();
    camera.health = "ok";
    frame();
    expect(game.init).toHaveBeenCalledOnce();
    expect(doubles.socket).not.toHaveBeenCalled();
    expect(doubles.recorder).not.toHaveBeenCalled();
    expect(session.room).toBeNull();
    expect(session.recording).toBe(false);
    win.dispatchEvent(
      Object.assign(new Event("keydown"), { key: "d", repeat: false })
    );
    session.dispose();
    host = undefined;
    expect(camera.dispose).toHaveBeenCalledOnce();
  });
});
