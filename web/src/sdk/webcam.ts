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
/** Per-hand grace: a hand unseen longer than this is marked inactive (blade hidden). */
const HAND_GRACE_MS = 250;
/** Min gap between detections. Small so we detect every fresh camera frame (lowest
 *  latency); the `video.currentTime` change gate keeps us from re-running the same frame. */
const DETECT_INTERVAL_MS = 15;
/** Openness maps this fingertip/palm ratio → [0,1] (fist → open). */
const OPEN_MIN = 1.1;
const OPEN_MAX = 2.0;
/** Light smoothing for openness (position uses the One-Euro filter below). */
const OPEN_SMOOTH = 0.5;

// Map a COMFORTABLE hand region in the camera frame to the FULL screen. Raw 1:1
// mapping felt cramped — you had to shove your hands to the frame edges to reach the
// screen edges. With gain, a relaxed movement around a natural center covers everything.
// Slightly higher X gain than Y because the screen is wider than the (4:3) camera frame.
const GAIN_X = 1.75;
const GAIN_Y = 1.55;
const CENTER_X = 0.5;
const CENTER_Y = 0.45; // hands rest a touch above frame-center while playing

/** Remap one filtered camera-frame coord to screen space around a center, with gain. */
function remap(v: number, center: number, gain: number): number {
  return clamp01(0.5 + (v - center) * gain);
}

/**
 * One-Euro filter — the standard adaptive low-pass for interactive pointing: it smooths
 * hard when the hand is slow (kills jitter) and barely at all when the hand is fast
 * (kills lag). Far better feel than a fixed EMA, which must trade jitter against latency.
 * See Casiez, Roussel & Vogel, "1€ Filter" (CHI 2012).
 */
class LowPass {
  private y = 0;
  private started = false;
  get value(): number {
    return this.y;
  }
  filter(x: number, alpha: number): number {
    this.y = this.started ? alpha * x + (1 - alpha) * this.y : x;
    this.started = true;
    return this.y;
  }
}

class OneEuro {
  private xLp = new LowPass();
  private dxLp = new LowPass();
  private tPrev = -1;
  constructor(
    private minCutoff = 1.2,
    private beta = 1.0,
    private dCutoff = 1.0,
  ) {}
  private alpha(dt: number, cutoff: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  /** Filter value `x` at time `t` (seconds). */
  filter(x: number, t: number): number {
    if (this.tPrev < 0) {
      this.tPrev = t;
      return this.xLp.filter(x, 1);
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    this.tPrev = t;
    const dx = (x - this.xLp.value) / dt;
    const edx = this.dxLp.filter(dx, this.alpha(dt, this.dCutoff));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xLp.filter(x, this.alpha(dt, cutoff));
  }
}

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
  leftHandActive = false;
  rightHandActive = false;
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
  /** When each hand was last individually detected (for per-hand active + assignment). */
  private lastLeftAt = -Infinity;
  private lastRightAt = -Infinity;
  /** One-Euro position filters per hand (x/y), for low-jitter, low-lag tracking. */
  private filters: Record<"left" | "right", { x: OneEuro; y: OneEuro }> = {
    left: { x: new OneEuro(), y: new OneEuro() },
    right: { x: new OneEuro(), y: new OneEuro() },
  };

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
          // Lower presence/tracking thresholds so an already-tracked hand isn't dropped
          // on a marginal frame (fewer flickers / blade dropouts); detection stays at 0.5.
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.3,
          minTrackingConfidence: 0.3,
        });
      // Prefer the GPU delegate (WebGL); fall back to CPU when WebGL is unavailable
      // (some browsers / VMs), so tracking still runs, just a little slower.
      this.landmarker = await make("GPU").catch(() => make("CPU"));

      // Higher capture resolution → crisper landmarks (a modern Mac handles 720p easily).
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          facingMode: "user",
        },
        audio: false,
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      await video.play();
      this.video = video;
      this.showPreview(video);

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

    // Per-hand active: a hand not seen within the grace window is inactive, so the
    // game hides its blade instead of leaving a frozen one in play.
    this.leftHandActive = nowMs - this.lastLeftAt < HAND_GRACE_MS;
    this.rightHandActive = nowMs - this.lastRightAt < HAND_GRACE_MS;

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

  /**
   * Assign the detected hands to the left/right blade slots with temporal stability:
   *  - Two hands: pick the pairing that minimizes movement from last frame (no swaps).
   *  - One hand: keep it on whichever slot is currently active (so a single hand doesn't
   *    hop sides); if neither/both active, use the nearer slot. The other slot is left
   *    untouched and ages out to inactive — so it's hidden, not frozen in play.
   */
  private applyResult(res: MpResult, now: number): void {
    const hands = res.landmarks ?? [];
    if (hands.length === 0) return;

    const dets = hands.map((lm) => {
      const palm = lm[9] ?? lm[0]; // middle-finger MCP ≈ palm center
      return {
        x: 1 - (palm?.x ?? 0.5), // MIRROR x so it feels like a mirror
        y: palm?.y ?? 0.5,
        open: handOpenness(lm),
        indexTip: lm[8],
      };
    });
    const lpos = this.joints.leftHand;
    const rpos = this.joints.rightHand;
    const d = (p: { x: number; y: number }, pos: [number, number]) =>
      Math.hypot(p.x - pos[0], p.y - pos[1]);

    if (dets.length === 1) {
      const one = dets[0]!;
      const leftActive = now - this.lastLeftAt < HAND_GRACE_MS;
      const rightActive = now - this.lastRightAt < HAND_GRACE_MS;
      let side: "left" | "right";
      if (leftActive && !rightActive) side = "left";
      else if (rightActive && !leftActive) side = "right";
      else side = d(one, lpos) <= d(one, rpos) ? "left" : "right";
      this.applyHand(side, one, now);
      if (side === "left") this.lastLeftAt = now;
      else this.lastRightAt = now;
    } else {
      const a = dets[0]!;
      const b = dets[1]!;
      const straight = d(a, lpos) + d(b, rpos);
      const swapped = d(a, rpos) + d(b, lpos);
      if (straight <= swapped) {
        this.applyHand("left", a, now);
        this.applyHand("right", b, now);
      } else {
        this.applyHand("left", b, now);
        this.applyHand("right", a, now);
      }
      this.lastLeftAt = now;
      this.lastRightAt = now;
    }

    this.lastHandAt = now;
  }

  private applyHand(
    which: "left" | "right",
    d: { x: number; y: number; open: number; indexTip: MpLandmark | undefined },
    nowMs: number,
  ): void {
    const key = which === "left" ? "leftHand" : "rightHand";
    const f = this.filters[which];
    const t = nowMs / 1000;
    // One-Euro filter the raw (mirrored) camera coords, THEN expand a comfortable region
    // to the full screen so relaxed movement covers everything.
    const fx = f.x.filter(clamp01(d.x), t);
    const fy = f.y.filter(clamp01(d.y), t);
    this.joints[key] = [remap(fx, CENTER_X, GAIN_X), remap(fy, CENTER_Y, GAIN_Y)];

    if (which === "left") {
      this.leftHandOpen += (d.open - this.leftHandOpen) * OPEN_SMOOTH;
      this.leftFingertip = d.indexTip
        ? [remap(1 - d.indexTip.x, CENTER_X, GAIN_X), remap(d.indexTip.y, CENTER_Y, GAIN_Y)]
        : undefined;
    } else {
      this.rightHandOpen += (d.open - this.rightHandOpen) * OPEN_SMOOTH;
      this.rightFingertip = d.indexTip
        ? [remap(1 - d.indexTip.x, CENTER_X, GAIN_X), remap(d.indexTip.y, CENTER_Y, GAIN_Y)]
        : undefined;
    }
  }

  /** Show the live camera feed as a small MIRRORED inset in the bottom-right corner, so
   *  the player can see themselves and frame their hands (like the phone's camera inset). */
  private showPreview(video: HTMLVideoElement): void {
    Object.assign(video.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      width: "22vw",
      maxWidth: "260px",
      aspectRatio: "4 / 3",
      objectFit: "cover",
      transform: "scaleX(-1)", // mirror to match the mirrored blade coordinates
      borderRadius: "12px",
      border: "2px solid rgba(120,200,255,0.5)",
      boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
      zIndex: "40",
      pointerEvents: "none",
    } as CSSStyleDeclaration);
    document.body.appendChild(video);
  }

  dispose(): void {
    const stream = this.video?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    this.video?.remove();
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
