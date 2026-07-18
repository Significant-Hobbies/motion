// Keyboard + mouse debug controller. Implements the SAME BodyController
// interface as the live PoseController so the entire game is playable with no
// phone. This is essential: the #1 product risk is control feel, and we must be
// able to playtest it end-to-end at the keyboard.
//
// Controls:
//   Mouse X/Y        → both hands track the cursor (mirrored L/R around cursor)
//   Left mouse button / Space      → close both hands (grab); release to open
//   Left / Right arrow (or A / D) → lean torso left / right (hold)
//   Down arrow / S                 → squat (hold)
//   Up arrow / W                   → stand tall (release squat quickly)
//
// The controller reports health "ok" as soon as the mouse has moved once, so
// the readiness gate passes in debug mode after any mouse movement.

import {
  type BodyController,
  type TrackingHealth,
  clamp01,
  clampSigned,
} from "./controller";
import type { Joints } from "../../../protocol/protocol";

const LERP = 0.35; // snappy but smoothed
const KEY_RAMP = 6; // how fast held keys drive lean/squat toward target (per sec)

export class KeyboardDebugController implements BodyController {
  joints: Joints = {
    head: [0.5, 0.18],
    leftHand: [0.4, 0.5],
    rightHand: [0.6, 0.5],
    torso: [0.5, 0.5],
    leftKnee: [0.42, 0.72],
    rightKnee: [0.58, 0.72],
    leftFoot: [0.42, 0.95],
    rightFoot: [0.58, 0.95],
  };
  squatAmount = 0;
  leanAmount = 0;
  leftHandOpen = 1;
  rightHandOpen = 1;
  // Mirror the debug hand positions as "fingertips" so the motion-maker cursor
  // shows in mouse mode too (set once the mouse has moved; undefined otherwise).
  leftFingertip: [number, number] | undefined = undefined;
  rightFingertip: [number, number] | undefined = undefined;
  trackingQuality = 1;
  health: TrackingHealth = "no_signal";
  hasRequiredJoints = false;
  ageMs = Infinity;

  private mouseX = 0.5;
  private mouseY = 0.5;
  private moved = false;
  private leanKey = 0; // −1 / 0 / +1 target
  private squatKey = false;
  private grabKey = false; // left mouse or space held → hands close
  private mouseDown = false;
  private lastTick = -1;
  private held = new Set<string>();

  constructor(private target: HTMLElement) {
    this.target.addEventListener("mousemove", this.onMouse);
    this.target.addEventListener("touchmove", this.onTouch, { passive: true });
    this.target.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseDown = true;
      this.recomputeKeys();
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseDown = false;
      this.recomputeKeys();
    }
  };

  private onMouse = (e: MouseEvent): void => {
    const r = this.target.getBoundingClientRect();
    this.mouseX = clamp01((e.clientX - r.left) / Math.max(1, r.width));
    this.mouseY = clamp01((e.clientY - r.top) / Math.max(1, r.height));
    this.moved = true;
  };

  private onTouch = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (!t) return;
    const r = this.target.getBoundingClientRect();
    this.mouseX = clamp01((t.clientX - r.left) / Math.max(1, r.width));
    this.mouseY = clamp01((t.clientY - r.top) / Math.max(1, r.height));
    this.moved = true;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    this.held.add(e.key.toLowerCase());
    this.recomputeKeys();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.key.toLowerCase());
    this.recomputeKeys();
  };

  private recomputeKeys(): void {
    const h = this.held;
    const left = h.has("arrowleft") || h.has("a");
    const right = h.has("arrowright") || h.has("d");
    this.leanKey = left && !right ? -1 : right && !left ? 1 : 0;
    this.squatKey = h.has("arrowdown") || h.has("s");
    // Left mouse OR space closes both hands (grab). Space no longer squats so the
    // two gestures never collide when testing the motion maker.
    this.grabKey = this.mouseDown || h.has(" ") || h.has("spacebar");
  }

  tick(nowMs: number): void {
    const dt =
      this.lastTick < 0 ? 0.016 : Math.min(0.05, (nowMs - this.lastTick) / 1000);
    this.lastTick = nowMs;

    // Drive lean/squat toward key targets with a ramp for a natural feel.
    const leanTarget = clampSigned(this.leanKey);
    this.leanAmount += (leanTarget - this.leanAmount) * Math.min(1, KEY_RAMP * dt);
    const squatTarget = this.squatKey ? 1 : 0;
    this.squatAmount += (squatTarget - this.squatAmount) * Math.min(1, KEY_RAMP * dt);

    // Hands: grab key closes both toward 0 (fist), otherwise open toward 1 (palm).
    const openTarget = this.grabKey ? 0 : 1;
    const openStep = Math.min(1, KEY_RAMP * dt);
    this.leftHandOpen += (openTarget - this.leftHandOpen) * openStep;
    this.rightHandOpen += (openTarget - this.rightHandOpen) * openStep;

    // Hands mirror around the cursor; a little apart so both are usable.
    const lhTarget: [number, number] = [clamp01(this.mouseX - 0.12), this.mouseY];
    const rhTarget: [number, number] = [clamp01(this.mouseX + 0.12), this.mouseY];
    this.joints.leftHand = lerp(this.joints.leftHand, lhTarget, LERP);
    this.joints.rightHand = lerp(this.joints.rightHand, rhTarget, LERP);

    // Torso follows lean; head sits above torso; knees/feet follow squat.
    const torsoX = 0.5 + this.leanAmount * 0.28;
    const torsoY = 0.5 + this.squatAmount * 0.1;
    this.joints.torso = lerp(this.joints.torso, [torsoX, torsoY], LERP);
    this.joints.head = lerp(this.joints.head, [torsoX, 0.18 + this.squatAmount * 0.16], LERP);
    this.joints.leftKnee = lerp(this.joints.leftKnee, [torsoX - 0.08, 0.72 + this.squatAmount * 0.05], LERP);
    this.joints.rightKnee = lerp(this.joints.rightKnee, [torsoX + 0.08, 0.72 + this.squatAmount * 0.05], LERP);
    this.joints.leftFoot = lerp(this.joints.leftFoot, [torsoX - 0.08, 0.95], LERP);
    this.joints.rightFoot = lerp(this.joints.rightFoot, [torsoX + 0.08, 0.95], LERP);

    if (this.moved) {
      this.health = "ok";
      this.hasRequiredJoints = true;
      this.ageMs = 0;
      this.trackingQuality = 1;
      // Precise-fingertip stand-in tracks the debug hands.
      this.leftFingertip = [this.joints.leftHand[0], this.joints.leftHand[1]];
      this.rightFingertip = [this.joints.rightHand[0], this.joints.rightHand[1]];
    } else {
      this.health = "no_signal";
      this.hasRequiredJoints = false;
      this.ageMs = Infinity;
      this.trackingQuality = 0;
      this.leftFingertip = undefined;
      this.rightFingertip = undefined;
    }
  }

  dispose(): void {
    this.target.removeEventListener("mousemove", this.onMouse);
    this.target.removeEventListener("touchmove", this.onTouch);
    this.target.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }
}

function lerp(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
