// WebcamController — a BodyController driven by the LAPTOP/desktop webcam, so the
// game is playable on a Mac (or any browser) with your body and NO phone. Hand
// tracking runs fully in-browser via MediaPipe Tasks (Hand Landmarker), loaded from
// CDN at runtime (no npm dependency, no bundle bloat). Browser-only — the phone uses
// its native camera pipeline instead.
//
// It produces the same shape the rest of the SDK reads: two hand joints + per-hand
// openness + a health flag. The other joints (head/torso/legs) are neutral defaults —
// the featured game (Slice) uses only the hands. Coordinates are MIRRORED in x so it
// feels like a mirror: move your right hand, the right blade moves.
//
// getUserMedia requires a secure context; http://localhost (and 127.0.0.1) qualify,
// so the dev server works without HTTPS. The camera the browser uses can be the Mac's
// own webcam OR an iPhone via Continuity Camera — both just appear as camera devices.

import {
  type BodyController,
  type TrackingHealth,
  clamp01,
} from "./controller";
import type { Joints } from "../../../protocol/protocol";

// MediaPipe Tasks (web) loaded from CDN at runtime — see loadMediaPipe().
const MP_VERSION = "0.10.14";
const MP_ESM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/+esm`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** After this long with no detected hand, the controller reports tracking lost. */
const LOST_AFTER_MS = 300;
/** Detection throttle — ~30 Hz is plenty and keeps the main thread responsive. */
const DETECT_INTERVAL_MS = 33;
/** Openness maps this fingertip/palm ratio → [0,1] (fist → open). */
const OPEN_MIN = 1.1;
const OPEN_MAX = 2.0;
/** Per-frame smoothing for hand position + openness. */
const SMOOTH = 0.5;

function neutralJoints(): Joints {
  return {
    head: [0.5, 0.18],
    leftHand: [0.35, 0.5],
    rightHand: [0.65, 0.5],
    torso: [0.5, 0.5],
    leftKnee: [0.42, 0.72],
    rightKnee: [0.58, 0.72],
    leftFoot: [0.42, 0.95],
    rightFoot: [0.58, 0.95],
  };
}

// Loose MediaPipe types — the module is imported at runtime from a URL.
/* eslint-disable @typescript-eslint/no-explicit-any */
type MpLandmark = { x: number; y: number; z: number };
type MpResult = { landmarks?: MpLandmark[][] };
type MpHandLandmarker = { detectForVideo(video: HTMLVideoElement, ts: number): MpResult };

export class WebcamController implements BodyController {
  joints: Joints = neutralJoints();
  squatAmount = 0;
  leanAmount = 0;
  leftHandOpen = 1;
  rightHandOpen = 1;
  leftFingertip: [number, number] | undefined = undefined;
  rightFingertip: [number, number] | undefined = undefined;
  trackingQuality = 0;
  health: TrackingHealth = "no_signal";
  hasRequiredJoints = false;
  ageMs = Infinity;

  private video: HTMLVideoElement | null = null;
  private landmarker: MpHandLandmarker | null = null;
  private status: HTMLDivElement;
  private ready = false;
  private failed = false;
  private lastVideoTime = -1;
  private lastDetectAt = -Infinity;
  private lastHandAt = -Infinity;

  constructor() {
    this.status = this.makeStatus("Starting camera… allow access when prompted.");
    void this.init();
  }

  private makeStatus(text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.textContent = text;
    Object.assign(el.style, {
      position: "absolute",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      padding: "0 32px",
      font: "500 18px/1.5 system-ui, sans-serif",
      color: "#cdd6f4",
      background: "#05070d",
      zIndex: "50",
      pointerEvents: "none",
    } as CSSStyleDeclaration);
    // Append to body (not the game overlay, which the host clears on screen changes)
    // so the loading/error message survives until the camera is actually up.
    document.body.appendChild(el);
    return el;
  }

  private async init(): Promise<void> {
    try {
      const mp: any = await import(/* @vite-ignore */ MP_ESM);
      const fileset = await mp.FilesetResolver.forVisionTasks(MP_WASM);
      const make = (delegate: "GPU" | "CPU") =>
        mp.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: "VIDEO",
          numHands: 2,
        });
      // Prefer the GPU delegate (WebGL); fall back to CPU when WebGL is unavailable
      // (some browsers / VMs), so tracking still runs, just a little slower.
      this.landmarker = await make("GPU").catch(() => make("CPU"));

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      await video.play();
      this.video = video;

      this.ready = true;
      this.status.style.display = "none";
    } catch (err) {
      this.failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      this.status.textContent =
        `Camera unavailable: ${msg}. Allow camera access (or pick a camera) and reload.`;
      // eslint-disable-next-line no-console
      console.error("[motion] webcam init failed:", err);
    }
  }

  tick(nowMs: number): void {
    if (this.ready && this.landmarker && this.video && !this.failed) {
      if (
        nowMs - this.lastDetectAt >= DETECT_INTERVAL_MS &&
        this.video.currentTime !== this.lastVideoTime &&
        this.video.readyState >= 2
      ) {
        this.lastDetectAt = nowMs;
        this.lastVideoTime = this.video.currentTime;
        try {
          this.applyResult(this.landmarker.detectForVideo(this.video, nowMs), nowMs);
        } catch {
          /* a dropped detection frame is harmless — keep last-known */
        }
      }
    }

    // Health from recency of a detected hand.
    this.ageMs = nowMs - this.lastHandAt;
    if (this.lastHandAt === -Infinity) {
      this.health = "no_signal";
      this.trackingQuality = 0;
      this.hasRequiredJoints = false;
    } else if (this.ageMs > LOST_AFTER_MS) {
      this.health = "stale";
      this.trackingQuality = 0;
      this.hasRequiredJoints = false;
    } else {
      this.health = "ok";
      this.trackingQuality = 1;
      this.hasRequiredJoints = true;
    }
  }

  /** Map the detected hands → left/right blade joints (by mirrored screen-x) + openness. */
  private applyResult(res: MpResult, now: number): void {
    const hands = res.landmarks ?? [];
    if (hands.length === 0) return;

    // Compute a mirrored palm center + openness for each detected hand.
    const detected = hands.map((lm) => {
      const palm = lm[9] ?? lm[0]; // middle-finger MCP ≈ palm center
      return {
        x: 1 - (palm?.x ?? 0.5), // MIRROR x so it feels like a mirror
        y: palm?.y ?? 0.5,
        open: handOpenness(lm),
        indexTip: lm[8],
      };
    });
    // Assign by screen-x: leftmost blade = left hand, rightmost = right hand.
    detected.sort((a, b) => a.x - b.x);
    const left = detected[0];
    const right = detected.length > 1 ? detected[detected.length - 1] : undefined;

    if (left) this.applyHand("left", left);
    if (right) this.applyHand("right", right);
    // With a single hand, only that side updates; the other blade holds its position.

    this.lastHandAt = now;
  }

  private applyHand(
    which: "left" | "right",
    d: { x: number; y: number; open: number; indexTip: MpLandmark | undefined },
  ): void {
    const key = which === "left" ? "leftHand" : "rightHand";
    const cur = this.joints[key] as [number, number];
    this.joints[key] = [
      cur[0] + (clamp01(d.x) - cur[0]) * SMOOTH,
      cur[1] + (clamp01(d.y) - cur[1]) * SMOOTH,
    ];
    if (which === "left") {
      this.leftHandOpen += (d.open - this.leftHandOpen) * SMOOTH;
      this.leftFingertip = d.indexTip ? [1 - d.indexTip.x, d.indexTip.y] : undefined;
    } else {
      this.rightHandOpen += (d.open - this.rightHandOpen) * SMOOTH;
      this.rightFingertip = d.indexTip ? [1 - d.indexTip.x, d.indexTip.y] : undefined;
    }
  }

  dispose(): void {
    const stream = this.video?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    this.video = null;
    this.landmarker = null;
    this.status.remove();
  }
}

/**
 * Hand openness 0 (fist) … 1 (open palm): mean fingertip→wrist distance normalized by
 * the wrist→middle-MCP (palm) length, mapped from [OPEN_MIN, OPEN_MAX]. Mirrors the
 * on-device formula so grab feels the same on Mac and phone. (x is mirrored elsewhere;
 * distances are mirror-invariant, so raw landmark coords are fine here.)
 */
function handOpenness(lm: MpLandmark[]): number {
  const wrist = lm[0];
  const midMcp = lm[9];
  if (!wrist || !midMcp) return 1;
  const palm = Math.hypot(wrist.x - midMcp.x, wrist.y - midMcp.y) || 1e-3;
  const tips = [8, 12, 16, 20];
  let sum = 0;
  let n = 0;
  for (const i of tips) {
    const t = lm[i];
    if (!t) continue;
    sum += Math.hypot(t.x - wrist.x, t.y - wrist.y);
    n++;
  }
  if (n === 0) return 1;
  const ratio = sum / n / palm;
  return clamp01((ratio - OPEN_MIN) / (OPEN_MAX - OPEN_MIN));
}
