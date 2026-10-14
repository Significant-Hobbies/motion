import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import {
  createSession,
  type GameHost,
  type SessionScreenRenderer,
} from "./index";
import type { MotionNativeApi } from "./bridge";
import type { Game } from "./game";
import type { PosePacket } from "../../../protocol/protocol";

const transport = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./room", () => ({
  Room: vi.fn(function forbiddenRelay() {
    transport.create();
    throw new Error("Bridge sessions must not create a relay");
  }),
}));

class SessionWindow extends EventTarget {
  innerWidth = 1440;
  innerHeight = 900;
  devicePixelRatio = 2;
  __motion?: MotionNativeApi;
  readonly postMessage = vi.fn();
  readonly webkit = {
    messageHandlers: { motion: { postMessage: this.postMessage } },
  };
}

class SessionCanvas extends EventTarget {
  width = 0;
  height = 0;
  style = {};
  readonly ctx = {
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillText: vi.fn(),
    measureText: () => ({ width: 200 }),
  };
  getContext() {
    return this.ctx;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1440, height: 900 };
  }
}

function pose(seq = 1): PosePacket {
  return {
    v: 1,
    type: "pose",
    seq,
    sentAt: 0,
    quality: 1,
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

describe("session bridge lifecycle and frame ownership", () => {
  let win: SessionWindow;
  let canvas: SessionCanvas;
  let host: GameHost | undefined;
  let nextId: number;
  let frames: Map<number, FrameRequestCallback>;
  let game: Game & {
    isOver: Mock<Game["isOver"]>;
    render: Mock<Game["render"]>;
  };
  let screens: SessionScreenRenderer;

  function mount(options = {}) {
    host = createSession({
      game,
      mount: {
        canvas: canvas as unknown as HTMLCanvasElement,
        overlay: { childElementCount: 0 } as HTMLElement,
      },
      screens,
      options: { partyHost: "relay.invalid", transport: "bridge", ...options },
    });
    return host;
  }

  function frame(now: number) {
    expect(frames.size).toBe(1);
    const [id, callback] = [...frames.entries()][0]!;
    frames.delete(id);
    vi.mocked(performance.now).mockReturnValue(now);
    callback(now);
  }

  beforeEach(() => {
    win = new SessionWindow();
    canvas = new SessionCanvas();
    frames = new Map();
    nextId = 0;
    transport.create.mockClear();
    vi.stubGlobal("window", win);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextId;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    game = {
      id: "fixture",
      name: "Fixture",
      durationMs: 1000,
      init: vi.fn(),
      reset: vi.fn(),
      update: vi.fn(),
      render: vi.fn(),
      isOver: vi.fn(() => false),
      result: vi.fn(() => ({ score: 7, stats: [] })),
      dispose: vi.fn(),
    };
    screens = {
      clear: vi.fn(),
      pairing: vi.fn(),
      mirror: vi.fn(),
      readiness: vi.fn(),
      trackingLost: vi.fn(),
      reconnecting: vi.fn(),
      results: vi.fn(),
    };
  });

  afterEach(() => {
    host?.dispose();
    host = undefined;
    expect(frames.size).toBe(0);
    expect(win.__motion).toBeUndefined();
    expect(transport.create).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts only on native request, pauses on tracking loss, emits results once and resets for replay", () => {
    const session = mount({ record: true });
    const screen = vi.fn();
    const result = vi.fn();
    session.on("screen", screen);
    const unsubscribe = session.on("result", result);
    expect(session.code).toBe("");
    expect(session.recording).toBe(false);
    expect(session.recordingPhase).toBe("idle");
    expect(session.lastClipUrl).toBeNull();
    expect(session.recorderNeedsMp4Warning).toBe(false);
    frame(20);
    expect(win.postMessage.mock.calls.map(([event]) => event.event)).toEqual([
      "ready",
    ]);
    expect(game.init).not.toHaveBeenCalled();
    win.__motion!.start();
    expect(game.init).toHaveBeenCalledWith({ width: 1440, height: 810 });
    frame(40);
    expect(game.update).not.toHaveBeenCalled();
    expect(screens.trackingLost).toHaveBeenCalledOnce();
    win.__motion!.pushPose(pose());
    frame(60);
    expect(game.update).toHaveBeenCalledWith(1000 / 60, session.controller);
    const updates = vi.mocked(game.update).mock.calls.length;
    win.__motion!.setTracking("lost");
    frame(80);
    expect(vi.mocked(game.update).mock.calls).toHaveLength(updates);
    win.__motion!.setTracking("ok");
    frame(100);
    expect(vi.mocked(game.update).mock.calls.length).toBeGreaterThan(updates);
    game.isOver.mockReturnValue(true);
    frame(120);
    frame(140);
    expect(result).toHaveBeenCalledExactlyOnceWith({ score: 7, stats: [] });
    expect(screen.mock.calls.map(([state]) => state)).toEqual([
      "game",
      "results",
    ]);
    expect(win.postMessage.mock.calls.map(([event]) => event.event)).toEqual([
      "ready",
      "gameStart",
      "score",
      "gameOver",
    ]);
    expect(win.postMessage).toHaveBeenCalledWith({ event: "score", value: 7 });
    expect(win.postMessage).toHaveBeenCalledWith({
      event: "gameOver",
      result: { score: 7, stats: [] },
    });
    const replay = vi.mocked(screens.results).mock.calls[0]![1];
    unsubscribe();
    replay();
    expect(game.reset).toHaveBeenCalledOnce();
    expect(game.init).toHaveBeenCalledTimes(2);
    expect(
      win.postMessage.mock.calls.slice(-2).map(([event]) => event.event)
    ).toEqual(["restart", "gameStart"]);
    win.__motion!.stop();
    expect(result).toHaveBeenCalledOnce();
    expect(screen).toHaveBeenLastCalledWith("bridge-idle");
  });

  it("contains render and diagnostic failures without losing the next frame", () => {
    mount();
    win.__motion!.start();
    game.render.mockImplementationOnce(() => {
      throw new Error("game draw failed");
    });
    canvas.ctx.fillText.mockImplementationOnce(() => {
      throw new Error("diagnostic draw failed");
    });
    frame(20);
    expect(console.error).toHaveBeenCalledWith(
      "[motion] frame error:",
      expect.objectContaining({ message: "game draw failed" })
    );
    frame(40);
    expect(game.render).toHaveBeenCalledTimes(2);
    expect(canvas.ctx.fillText).toHaveBeenCalledWith(
      "MOTION FRAME ERROR",
      10,
      8
    );
    expect(frames.size).toBe(1);
  });

  it("starts after the bounded idle fallback and re-arms it after native stop", () => {
    mount({ skipReadiness: true });
    frame(20);
    frame(1520);
    expect(game.init).not.toHaveBeenCalled();
    frame(1540);
    expect(game.init).toHaveBeenCalledOnce();
    win.__motion!.stop();
    frame(1560);
    frame(3060);
    expect(game.reset).not.toHaveBeenCalled();
    frame(3080);
    expect(game.reset).toHaveBeenCalledOnce();
    expect(game.init).toHaveBeenCalledTimes(2);
  });

  it("caps catch-up updates and removes debug input and resize listeners on disposal", () => {
    const session = mount({ debug: true, skipReadiness: true });
    canvas.dispatchEvent(
      Object.assign(new Event("mousemove"), { clientX: 720, clientY: 450 })
    );
    frame(20);
    frame(10_020);
    expect(game.update).toHaveBeenCalledTimes(5);
    const controller = session.controller;
    const width = canvas.width;
    const lateFrame = [...frames.values()][0]!;
    const renders = game.render.mock.calls.length;
    session.dispose();
    host = undefined;
    expect(game.dispose).toHaveBeenCalledOnce();
    win.innerWidth = 390;
    win.dispatchEvent(new Event("resize"));
    win.dispatchEvent(
      Object.assign(new Event("keydown"), { key: "d", repeat: false })
    );
    expect(canvas.width).toBe(width);
    expect(session.controller).toBe(controller);
    // A callback already delivered by the browser must also obey disposal.
    lateFrame(10_040);
    expect(game.render).toHaveBeenCalledTimes(renders);
    expect(frames.size).toBe(0);
  });

  it("does not resurrect the frame loop when the game disposes its host during render", () => {
    const session = mount();
    win.__motion!.start();
    game.render.mockImplementationOnce(() => session.dispose());
    frame(20);
    host = undefined;
    expect(game.dispose).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
});
