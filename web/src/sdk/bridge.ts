// In-process JS bridge transport — Motion's serverless single-device v1 POC.
//
// v1 pivot: the iOS app hosts THIS web game inside a WKWebView shown full-screen
// on the phone (mirrored to a TV via AirPlay). The phone runs the camera + Vision
// pose LOCALLY and injects pose into the web game in-process via a JavaScript
// bridge — NO WebSocket, NO relay, NO room pairing. (The socket transport in
// room.ts stays for v2: browser + multiplayer.)
//
// Two halves:
//   1. `BridgeController` — a BodyController fed by pose frames the native side
//      PUSHES in (vs PoseController, which reads them off a socket). It reuses
//      the SAME smoothing / stale-seq-rejection / squat-lean derivation via the
//      shared `PoseControllerBase`.
//   2. `NativeBridge` — installs `window.__motion` (native → web calls) and
//      emits lifecycle events web → native through the WKWebView message handler
//      `window.webkit.messageHandlers.motion`. In a plain browser the message
//      handler is absent, so every emit is a guarded no-op.

import { PoseControllerBase } from "./controller";
import type { PosePacket } from "../../../protocol/protocol";

/** Native tracking state pushed via `window.__motion.setTracking(...)`. */
export type BridgeTrackingState =
  | "ok"
  | "lost"
  | "partial"
  | "too_close"
  | "too_far"
  | "raise_phone"
  | "low_light";

/**
 * BodyController driven by pose frames the native host pushes in-process (no
 * socket). All control-feel logic (smoothing, stale rejection, gesture
 * derivation, health classification) is inherited unchanged from
 * `PoseControllerBase`; this class only adds a coarse native tracking flag that
 * lets native force a "lost" state ahead of the natural staleness timeout.
 */
export class BridgeController extends PoseControllerBase {
  private nativeLost = false;

  /** Consume one native-pushed pose frame (same shape as a relay PosePacket). */
  pushPose(p: PosePacket): void {
    this.nativeLost = false;
    this.ingest(p);
  }

  /**
   * Native tracking hint. Anything other than "ok" is treated as tracking loss
   * so the game pauses immediately, without waiting for frames to go stale.
   */
  setTracking(state: BridgeTrackingState): void {
    this.nativeLost = state !== "ok";
  }

  override tick(nowMs: number): void {
    super.tick(nowMs);
    if (this.nativeLost && this.health === "ok") {
      // Native says tracking is lost even though the last frame was fresh —
      // downgrade to "stale" so the GameHost pause logic engages.
      this.health = "stale";
    }
  }
}

/** The native → web API surface installed on `window.__motion`. */
export interface MotionNativeApi {
  /** Push one pose frame (PosePacket shape). `BridgeController` consumes it. */
  pushPose(json: PosePacket | string): void;
  /** Report native tracking state; drives readiness/pause. */
  setTracking(state: BridgeTrackingState): void;
  /** Begin the game (readiness already satisfied on the phone). */
  start(): void;
  /** End / abort the current game. */
  stop(): void;
  /** Signal that calibration finished on the phone. */
  calibrated(): void;
}

/** Lifecycle events emitted web → native (WKWebView message handler payloads). */
export type NativeEvent =
  | { event: "ready" }
  | { event: "gameStart" }
  | { event: "gameOver"; result: unknown }
  | { event: "score"; value: number }
  | { event: "restart" };

/** WKScriptMessageHandler surface Safari injects into a WKWebView. */
interface WebkitMessageHandler {
  postMessage(msg: unknown): void;
}
interface WebkitBridge {
  messageHandlers?: { motion?: WebkitMessageHandler };
}

/** The WKWebView message handler, or undefined in a plain browser. */
function webkitHandler(): WebkitMessageHandler | undefined {
  const w = window as unknown as { webkit?: WebkitBridge };
  return w.webkit?.messageHandlers?.motion;
}

/**
 * True when running inside the Motion WKWebView host (the message handler is
 * present). Used by config to auto-select the bridge transport.
 */
export function hasNativeBridge(): boolean {
  return webkitHandler() !== undefined;
}

/** Callbacks the GameHost registers so native → web calls drive the session. */
export interface BridgeHostCallbacks {
  onStart(): void;
  onStop(): void;
  onCalibrated(): void;
  onTracking(state: BridgeTrackingState): void;
}

/**
 * Owns the `window.__motion` global (native → web) and the web → native event
 * channel. Constructed once by the GameHost in bridge mode. Feeds pose frames
 * into the supplied `BridgeController` and forwards lifecycle calls to the host.
 */
export class NativeBridge {
  constructor(
    private controller: BridgeController,
    private callbacks: BridgeHostCallbacks
  ) {
    this.install();
  }

  private install(): void {
    const api: MotionNativeApi = {
      pushPose: (json) => this.onPushPose(json),
      setTracking: (state) => {
        this.controller.setTracking(state);
        this.callbacks.onTracking(state);
      },
      start: () => this.callbacks.onStart(),
      stop: () => this.callbacks.onStop(),
      calibrated: () => this.callbacks.onCalibrated(),
    };
    (window as unknown as { __motion: MotionNativeApi }).__motion = api;
  }

  private onPushPose(json: PosePacket | string): void {
    let packet: PosePacket | null = null;
    if (typeof json === "string") {
      try {
        packet = JSON.parse(json) as PosePacket;
      } catch {
        return; // malformed frame — drop it
      }
    } else {
      packet = json;
    }
    if (packet && packet.type === "pose") this.controller.pushPose(packet);
  }

  /** Emit a lifecycle event web → native. No-op in a plain browser. */
  emit(evt: NativeEvent): void {
    webkitHandler()?.postMessage(evt);
  }

  /** Remove the global. */
  dispose(): void {
    const w = window as unknown as { __motion?: MotionNativeApi };
    if (w.__motion) delete w.__motion;
  }
}
