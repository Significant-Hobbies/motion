// Motion SDK — public surface.
//
// A motion-controller platform where *any* game is a drop-in. The host owns:
//   - the room (PartySocket relay) and a stable 6-char code,
//   - the active BodyController (live pose OR keyboard-debug),
//   - the readiness gate + calibration handshake,
//   - the fixed-timestep update + interpolated (frame-time) render loop,
//   - tracking-loss pause/resume,
//   - results + Play Again,
//   - the recording lifecycle (record the game canvas, ship to the phone).
//
// A game reads ONLY the BodyController abstraction and draws through Renderer.
// Consumers call `createSession({ game, mount, options })`.

import { Room, type ConnState } from "./room";
import { CanvasSurface } from "./canvas";
import { drawSkeleton } from "./skeleton";
import { PoseController, type BodyController } from "./controller";
import { KeyboardDebugController } from "./keyboard-debug";
import {
  BridgeController,
  NativeBridge,
  type BridgeTrackingState,
} from "./bridge";
import { WebcamController } from "./webcam";
import { Readiness } from "./calibration";
import { Diagnostics } from "./diagnostics";
import { CanvasRecorder } from "./recording";
import { CanvasRenderer, type Game } from "./game";
import type {
  GameResult,
  RecordingState,
  SessionEvents,
  SessionScreen,
} from "./types";

export { Room } from "./room";
export type { ConnState } from "./room";
export { CanvasSurface } from "./canvas";
export { PoseController } from "./controller";
export { KeyboardDebugController } from "./keyboard-debug";
export { BridgeController, NativeBridge } from "./bridge";
export type {
  BridgeTrackingState,
  MotionNativeApi,
  NativeEvent,
} from "./bridge";
export { drawSkeleton } from "./skeleton";
export { Readiness } from "./calibration";
export type { ReadinessState } from "./calibration";
export { Diagnostics } from "./diagnostics";
export {
  CanvasRecorder,
  pickRecordingMime,
  isCompositable,
} from "./recording";
export type { RecordingPhase } from "./recording";
export { CanvasRenderer } from "./game";
export type { Game } from "./game";
export type {
  BodyController,
  TrackingHealth,
  Vec2,
} from "./controller";
export type {
  GameContext,
  GameResult,
  Renderer,
  RecordingState,
  SessionEvents,
  SessionScreen,
} from "./types";

/** Options for a session. All optional except the ones with sane defaults. */
export interface SessionOptions {
  /** PartyKit relay host. */
  partyHost: string;
  /** Force a specific room code (rejoin). */
  forcedRoom?: string;
  /** Start in keyboard/mouse debug mode (no phone). */
  debug?: boolean;
  /** Record the game canvas + ship to phone (default off; user-toggleable). */
  record?: boolean;
  /**
   * Input transport. `'socket'` (default) is the PartyKit relay: browser +
   * multiplayer (v2). `'bridge'` is the in-process JS bridge for the embedded
   * WKWebView single-device POC (v1): native pushes pose in-process, drives the
   * game lifecycle via `window.__motion`, and captures the screen with
   * ReplayKit — so there's NO room, NO pairing, and the web MediaRecorder stays
   * off. See `sdk/bridge.ts`.
   */
  transport?: "socket" | "bridge";
  /**
   * Skip the mirror + readiness-gate ceremony and drop straight into the game as
   * soon as usable input is present (socket mode). Used by the interactive
   * "motion maker" mirror, which is a live playground rather than a timed round.
   * In debug mode the game starts immediately (mouse movement supplies input).
   */
  skipReadiness?: boolean;
  /**
   * Drive the game from THIS device's webcam via in-browser MediaPipe hand tracking
   * (no phone, no relay). Browser-only. Uses `WebcamController` as the body and runs
   * without a room — the game starts once the camera first detects a hand.
   */
  camera?: boolean;
}

export interface CreateSessionArgs {
  /** The game to run. */
  game: Game;
  /** Canvas + overlay mount points. */
  mount: { canvas: HTMLCanvasElement; overlay: HTMLElement };
  options: SessionOptions;
  /**
   * Screen renderer supplied by the host app: given the current screen + state,
   * it draws the HTML overlay panels. Keeps the SDK free of app chrome/copy.
   */
  screens: SessionScreenRenderer;
}

/** The app supplies this so the SDK stays free of HTML copy/branding. */
export interface SessionScreenRenderer {
  clear(): void;
  pairing(ctx: PairingCtx): void;
  mirror(): void;
  readiness(state: import("./calibration").ReadinessState, debug: boolean): void;
  trackingLost(): void;
  reconnecting(): void;
  results(result: GameResult, onPlayAgain: () => void): void;
}

export interface PairingCtx {
  code: string;
  conn: ConnState;
  host: string;
  debug: boolean;
  recordOn: boolean;
  onToggleRecord: (on: boolean) => void;
}

const STEP_MS = 1000 / 60;

/**
 * Bridge mode only: if native never round-trips `start()` after the web view is
 * up, auto-start the game once this long has elapsed in `bridge-idle` so the
 * phone can never sit on a blank idle surface forever.
 */
const BRIDGE_IDLE_FALLBACK_MS = 1500;

/**
 * Owns one running Motion session for a single `Game`. Construct via
 * `createSession`. Drives a requestAnimationFrame loop with fixed-timestep
 * updates and frame-time rendering.
 */
export class GameHost {
  /** The relay room in socket mode; null in bridge (embedded/v1) mode. */
  readonly room: Room | null;
  private surf: CanvasSurface;
  private renderer: CanvasRenderer;
  private overlayEl: HTMLElement;
  private canvasEl: HTMLCanvasElement;
  private game: Game;
  private screens: SessionScreenRenderer;
  private options: SessionOptions;

  private readonly transport: "socket" | "bridge";
  private readonly skipReadiness: boolean;
  private poseController: PoseController;
  private body: BodyController;
  private debugMode: boolean;

  /** Webcam (browser MediaPipe) controller when `options.camera`; null otherwise. */
  private webcamController: WebcamController | null = null;

  // Bridge (embedded/v1) mode only; null in socket mode.
  private bridgeController: BridgeController | null = null;
  private nativeBridge: NativeBridge | null = null;
  /** Set true once native calls start(); the phone already ran readiness. */
  private nativeStartRequested = false;

  private readiness: Readiness | null;
  private diagnostics: Diagnostics | null = null;
  /** Canvas recorder in socket mode; null in bridge mode (ReplayKit records). */
  private recorder: CanvasRecorder | null;
  private recordOn: boolean;
  private recPhase: RecordingState = "idle";

  private screen: SessionScreen;
  private mirrorStableSince = -1;
  /**
   * Wall-clock ms when we first entered `bridge-idle` (bridge mode only), used to
   * bound how long we can sit idle before auto-starting the game. -1 until set.
   */
  private bridgeIdleSince = -1;
  private paused = false;
  private lastResult: GameResult | null = null;
  private gameInited = false;

  private acc = 0;
  private last = performance.now();
  private rafId = 0;
  private stopped = false;
  /** Last frame's uncaught error (message + stack), surfaced by `drawDiag`. */
  private lastError: string | null = null;
  private lastErrorStack = "";
  /** True once the `ready` event has been emitted web → native. */
  private readyEmitted = false;

  private listeners: { [K in keyof SessionEvents]: Set<SessionEvents[K]> } = {
    screen: new Set(),
    result: new Set(),
    recording: new Set(),
  };

  constructor(args: CreateSessionArgs) {
    this.game = args.game;
    this.screens = args.screens;
    this.options = args.options;
    this.canvasEl = args.mount.canvas;
    this.overlayEl = args.mount.overlay;
    this.debugMode = !!args.options.debug;
    this.recordOn = !!args.options.record;
    this.transport = args.options.transport ?? "socket";
    this.skipReadiness = !!args.options.skipReadiness;

    this.surf = new CanvasSurface(this.canvasEl);
    this.renderer = new CanvasRenderer(this.surf);

    // Pose controller exists in both modes so the debug toggle can always fall
    // back to it; only in socket mode is it fed by a Room.
    this.poseController = new PoseController();

    if (this.transport === "bridge") {
      // Embedded/v1: no room, no pairing, no relay. Native pushes pose in-process
      // and drives the lifecycle via window.__motion.
      this.room = null;
      this.readiness = null;
      this.recorder = null; // ReplayKit records the screen natively.
      this.recordOn = false;

      this.bridgeController = new BridgeController();
      this.nativeBridge = new NativeBridge(this.bridgeController, {
        onStart: () => this.onNativeStart(),
        onStop: () => this.onNativeStop(),
        onCalibrated: () => {
          /* readiness ran on the phone; nothing to gate here */
        },
        onTracking: (state) => this.onNativeTracking(state),
      });

      this.body = this.debugMode
        ? new KeyboardDebugController(this.canvasEl)
        : this.bridgeController;

      this.screen = "bridge-idle";
    } else if (args.options.camera) {
      // Webcam mode: this device's own camera drives the game via in-browser
      // MediaPipe. No room, no relay, no recorder — like bridge but in a browser.
      // `skipReadiness` (forced on by the app for camera) drops us into the game as
      // soon as the camera first sees a hand.
      this.room = null;
      this.readiness = null;
      this.recorder = null;
      this.recordOn = false;

      this.webcamController = new WebcamController();
      this.body = this.debugMode
        ? new KeyboardDebugController(this.canvasEl)
        : this.webcamController;

      this.screen = "pairing"; // renders blank without a room; advances on first hand
    } else {
      this.room = new Room(args.options.partyHost, args.options.forcedRoom);
      this.room.on("pose", (p) => this.poseController.ingest(p));

      this.body = this.debugMode
        ? new KeyboardDebugController(this.canvasEl)
        : this.poseController;

      this.readiness = new Readiness(this.room, this.debugMode);

      this.recorder = new CanvasRecorder({
        room: this.room,
        canvas: this.canvasEl,
        onPhase: (phase, detail) => {
          this.recPhase = phase;
          this.emit("recording", phase, detail);
        },
      });

      if (this.debugMode) {
        this.diagnostics = new Diagnostics(this.overlayEl, this.room, false);
      }

      this.screen = "pairing";
    }

    window.addEventListener("keydown", this.onKeyDown);
  }

  // ── Bridge (embedded/v1) native → web handlers ───────────────────────────────

  private onNativeStart(): void {
    // If we're idle or on results, (re)start the game immediately. Otherwise
    // latch the request so the loop consumes it once bridge-idle is reached
    // (e.g. start() arriving before the first frame).
    if (this.screen === "bridge-idle" || this.screen === "results") {
      this.nativeStartRequested = false;
      this.setScreen("game");
    } else {
      this.nativeStartRequested = true;
    }
  }

  private onNativeStop(): void {
    // Abort back to idle; if a game was running, surface its result first.
    if (this.screen === "game") {
      this.lastResult = this.game.result();
      if (this.lastResult) this.emit("result", this.lastResult);
    }
    this.nativeStartRequested = false;
    this.setScreen("bridge-idle");
  }

  private onNativeTracking(state: BridgeTrackingState): void {
    // BridgeController already applies this to health; pause is derived in step().
    void state;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Current 6-char room code (stable across reconnects); "" in bridge mode. */
  get code(): string {
    return this.room?.code ?? "";
  }

  /** Whichever controller is currently active (pose or keyboard-debug). */
  get controller(): BodyController {
    return this.body;
  }

  /** Whether recording is armed for the next game. */
  get recording(): boolean {
    return this.recordOn;
  }

  get recordingPhase(): RecordingState {
    return this.recPhase;
  }

  /** True if MediaRecorder can produce a phone-compositable MP4 clip. */
  get recorderNeedsMp4Warning(): boolean {
    return this.recorder?.needsMp4Warning ?? false;
  }

  /** URL of the last finished clip for browser-side download (or null). */
  get lastClipUrl(): string | null {
    return this.recorder?.downloadUrl ?? null;
  }

  setRecordEnabled(on: boolean): void {
    this.recordOn = on;
  }

  on<K extends keyof SessionEvents>(event: K, fn: SessionEvents[K]): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  private emit<K extends keyof SessionEvents>(
    event: K,
    ...args: Parameters<SessionEvents[K]>
  ): void {
    for (const fn of this.listeners[event]) {
      (fn as (...a: Parameters<SessionEvents[K]>) => void)(...args);
    }
  }

  /** Begin the render loop. */
  start(): void {
    this.stopped = false;
    this.last = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Stop everything and free resources. */
  dispose(): void {
    this.stopped = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    window.removeEventListener("keydown", this.onKeyDown);
    if (this.body instanceof KeyboardDebugController) this.body.dispose();
    this.poseController.dispose();
    this.webcamController?.dispose();
    this.bridgeController?.dispose();
    this.nativeBridge?.dispose();
    this.diagnostics?.dispose();
    this.recorder?.dispose();
    this.game.dispose?.();
    this.surf.dispose();
    this.room?.close();
  }

  // ── Debug toggle (`d`) ────────────────────────────────────────────────────

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key.toLowerCase() === "d" && !e.repeat) {
      this.toggleDebug();
    }
  };

  private toggleDebug(): void {
    this.debugMode = !this.debugMode;
    if (this.body instanceof KeyboardDebugController) this.body.dispose();
    // The live fallback controller depends on the mode.
    const live: BodyController =
      this.transport === "bridge" && this.bridgeController
        ? this.bridgeController
        : this.webcamController ?? this.poseController;
    this.body = this.debugMode
      ? new KeyboardDebugController(this.canvasEl)
      : live;
    // Diagnostics needs a Room (RTT/pose rate); only available in socket mode.
    this.diagnostics?.dispose();
    this.diagnostics =
      this.debugMode && this.room
        ? new Diagnostics(this.overlayEl, this.room, false)
        : null;
  }

  // ── Screen state ───────────────────────────────────────────────────────────

  private setScreen(next: SessionScreen): void {
    const wasResults = this.screen === "results";
    this.screen = next;
    this.screens.clear();
    // Re-arm the bridge-idle fallback timer each time we (re)enter idle.
    if (next === "bridge-idle") this.bridgeIdleSince = -1;
    if (next === "game") {
      const replay = this.gameInited;
      if (!this.gameInited) {
        this.game.init({ width: this.surf.play.w, height: this.surf.play.h });
        this.gameInited = true;
      } else {
        this.game.reset();
        this.game.init({ width: this.surf.play.w, height: this.surf.play.h });
      }
      this.room?.start(); // cue the controller (socket mode)
      this.paused = false;
      // Socket mode records the canvas + ships to phone. Bridge (embedded/v1)
      // mode does NOT: ReplayKit captures the screen natively — we only bracket
      // it with gameStart/gameOver events.
      if (this.transport === "bridge") {
        if (replay || wasResults) this.nativeBridge?.emit({ event: "restart" });
        this.nativeBridge?.emit({ event: "gameStart" });
      } else if (this.recordOn && CanvasRecorder.supported) {
        this.recorder?.start();
      }
    }
    this.emit("screen", next);
  }

  // ── Loop ───────────────────────────────────────────────────────────────────

  private frame = (now: number): void => {
    if (this.stopped) return;
    // CRASH-PROOF: a throw anywhere in step/render must NOT kill the RAF loop
    // (the reschedule is in `finally`), or the game freezes on a dead frame. Any
    // error is captured and surfaced on-screen by `drawDiag` instead of vanishing
    // into the console (invisible inside a phone WKWebView).
    try {
      const dtWallMs = Math.min(100, now - this.last);
      this.last = now;

      this.body.tick(now);

      this.acc += dtWallMs;
      let steps = 0;
      while (this.acc >= STEP_MS && steps < 5) {
        this.step(STEP_MS, now);
        this.acc -= STEP_MS;
        steps++;
      }

      this.render(now);
      this.diagnostics?.update(this.body);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastErrorStack = err instanceof Error ? (err.stack ?? "") : "";
      console.error("[motion] frame error:", err);
    }
    if (this.debugMode || this.lastError) {
      try {
        this.drawDiag();
      } catch {
        /* diagnostics must never break the game loop */
      }
    }
    this.rafId = requestAnimationFrame(this.frame);
  };

  /**
   * Draw a tiny always-on status readout (and, if the last frame threw, a red
   * error banner) directly on the canvas. Visible even inside the phone WKWebView
   * where there's no console — this is how we see what the running game is doing.
   */
  private drawDiag(): void {
    const ctx = this.surf.ctx;
    const dpr = this.surf.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const b = this.body;
    const age = Number.isFinite(b.ageMs) ? Math.round(b.ageMs) : -1;
    const line =
      `scr:${this.screen} h:${b.health} age:${age}ms ` +
      `q:${b.trackingQuality.toFixed(2)} L:${b.leftHandOpen.toFixed(2)} R:${b.rightHandOpen.toFixed(2)}`;

    ctx.save();
    ctx.font = "12px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const y = window.innerHeight - 6;
    const w = ctx.measureText(line).width + 12;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(4, y - 16, w, 20);
    ctx.fillStyle = "#37ff8b";
    ctx.fillText(line, 10, y);
    ctx.restore();

    if (this.lastError) {
      ctx.save();
      ctx.fillStyle = "rgba(150,0,0,0.92)";
      ctx.fillRect(0, 0, window.innerWidth, 96);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.font = "bold 13px monospace";
      ctx.fillText("MOTION FRAME ERROR", 10, 8);
      ctx.font = "12px monospace";
      ctx.fillText(this.lastError.slice(0, 90), 10, 30);
      const frame0 = (this.lastErrorStack.split("\n")[1] ?? "").trim();
      ctx.fillText(frame0.slice(0, 90), 10, 50);
      ctx.restore();
    }
  }

  private step(dtMs: number, now: number): void {
    switch (this.screen) {
      case "bridge-idle": {
        // Embedded/v1: readiness ran on the phone. Native normally flips us to
        // "game" via window.__motion.start(). But that round-trip can hang (or
        // never fire), which used to leave the phone stuck on a blank idle
        // surface after calibration. So we self-advance:
        //   1. immediately when native's start() latched a request, OR
        //   2. as soon as usable input is flowing when readiness is skipped
        //      (the on-phone Motion Maker: it's a live mirror, not a gated
        //      round — no second native handshake required), OR
        //   3. after a short fallback timeout regardless, so idle can't deadlock.
        if (this.bridgeIdleSince < 0) this.bridgeIdleSince = now;

        if (this.nativeStartRequested) {
          this.nativeStartRequested = false;
          this.setScreen("game");
          break;
        }

        if (this.transport === "bridge" && this.skipReadiness) {
          const inputFlowing = this.body.health !== "no_signal";
          const timedOut = now - this.bridgeIdleSince > BRIDGE_IDLE_FALLBACK_MS;
          if (inputFlowing || timedOut) {
            this.setScreen("game");
          }
        }
        break;
      }

      case "pairing":
        if (this.skipReadiness) {
          // Interactive mirror (motion-maker): drop into the live playground the
          // moment ANY fresh pose arrives — do NOT wait for a full-body lock. The
          // scene is upper-body friendly and handles partial bodies itself.
          // `no_signal` = we've never received a fresh packet; anything else means
          // the phone is streaming, so a desk / upper-body pose advances us.
          if (this.body.health !== "no_signal") this.setScreen("game");
        } else if (this.body.hasRequiredJoints && this.body.health === "ok") {
          this.mirrorStableSince = -1;
          this.setScreen("mirror");
        }
        break;

      case "mirror": {
        const ok = this.body.health === "ok" && this.body.hasRequiredJoints;
        if (ok) {
          if (this.mirrorStableSince < 0) this.mirrorStableSince = now;
          if (now - this.mirrorStableSince > 2000) this.setScreen("readiness");
        } else {
          this.mirrorStableSince = -1;
        }
        break;
      }

      case "readiness": {
        if (!this.readiness) break; // bridge mode never enters this screen
        const st = this.readiness.evaluate(this.body, now);
        if (st.ready) this.setScreen("game");
        if (!st.peer && !this.debugMode) this.setScreen("pairing");
        break;
      }

      case "game": {
        // Tracking-loss: pause within ~1s if the body goes stale.
        const lost =
          this.body.health === "stale" || this.body.health === "no_signal";
        this.paused = lost;
        if (!this.paused) this.game.update(dtMs, this.body);
        if (this.game.isOver()) {
          this.lastResult = this.game.result();
          void this.finishGame();
        }
        break;
      }

      case "results":
        break;
    }
  }

  private async finishGame(): Promise<void> {
    // Socket mode: stop + ship the canvas recording (fire-and-forget; results
    // show immediately). Bridge mode records natively (ReplayKit), so instead we
    // emit gameOver/score so native can bracket its own screen recording.
    if (this.transport === "bridge") {
      if (this.lastResult) {
        this.nativeBridge?.emit({ event: "score", value: this.lastResult.score });
      }
      this.nativeBridge?.emit({
        event: "gameOver",
        result: this.lastResult ?? null,
      });
    } else if (this.recordOn && this.recorder?.phase === "recording") {
      void this.recorder.stop();
    }
    if (this.lastResult) this.emit("result", this.lastResult);
    this.setScreen("results");
  }

  private render(now: number): void {
    this.surf.begin();

    // The canvas is up on the first rendered frame — tell native it can start
    // ReplayKit setup / show us. No-op in a plain browser.
    if (!this.readyEmitted) {
      this.readyEmitted = true;
      this.nativeBridge?.emit({ event: "ready" });
    }

    switch (this.screen) {
      case "bridge-idle":
        // Native owns pairing/readiness UI on the phone; the embedded web view
        // just holds a blank surface until start() arrives. Clear stray overlay.
        if (this.overlayEl.childElementCount > 0) this.screens.clear();
        break;

      case "pairing":
        if (this.room) {
          this.screens.pairing({
            code: this.room.code,
            conn: this.room.connectionState,
            host: this.options.partyHost,
            debug: this.debugMode,
            recordOn: this.recordOn,
            onToggleRecord: (on) => this.setRecordEnabled(on),
          });
        }
        break;

      case "mirror":
        drawSkeleton(this.surf, this.body);
        this.screens.mirror();
        break;

      case "readiness": {
        if (!this.readiness) break;
        drawSkeleton(this.surf, this.body, { alpha: 0.4 });
        const st = this.readiness.evaluate(this.body, now);
        this.screens.readiness(st, this.debugMode);
        break;
      }

      case "game":
        this.game.render(this.renderer);
        if (this.paused) {
          this.screens.trackingLost();
        } else if (
          this.room !== null &&
          this.room.connectionState !== "open" &&
          !this.debugMode
        ) {
          this.screens.reconnecting();
        } else if (this.overlayEl.childElementCount > 0) {
          this.screens.clear();
        }
        break;

      case "results":
        if (this.lastResult && this.overlayEl.childElementCount === 0) {
          this.screens.results(this.lastResult, () => this.setScreen("game"));
        }
        break;
    }
  }
}

/** Create + start a session. Returns the host for further control. */
export function createSession(args: CreateSessionArgs): GameHost {
  const host = new GameHost(args);
  host.start();
  return host;
}
