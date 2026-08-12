// BodyController: the ONLY interface the game reads for input.
//
// Both the live pose-driven controller and the keyboard-debug controller
// implement this. The game never touches raw pose packets — it reads the
// smoothed joints + derived gestures below. This is the single most important
// abstraction for control feel: smoothing + stale rejection happen here so the
// game loop stays simple and responsive.

import {
  ARM_JOINT_NAMES,
  JOINT_NAMES,
  type Joints,
  type PosePacket,
} from "../../../protocol/protocol";

export type Vec2 = readonly [number, number];

/** Which reason (if any) tracking is currently unusable. */
export type TrackingHealth = "ok" | "stale" | "low_quality" | "no_signal";

export interface BodyController {
  /** Smoothed joints in 0..1, origin top-left. Always defined (last-known if stale). */
  readonly joints: Joints;
  /** 0 = standing, 1 = deep squat. */
  readonly squatAmount: number;
  /** Signed lean of the torso: −1 = full left, +1 = full right. */
  readonly leanAmount: number;
  /**
   * Left-hand openness: 0 = closed fist … 1 = fully open palm. Smoothed like the
   * joints. Defaults to 1 (open) when the source has no hand data, so nothing
   * falsely grabs. Matches `joints.leftHand`.
   */
  readonly leftHandOpen: number;
  /** Right-hand openness (0 closed … 1 open). Matches `joints.rightHand`. */
  readonly rightHandOpen: number;
  /**
   * Precise left index-fingertip in 0..1 (top-left origin), from ROI-zoomed hand
   * tracking. Smoothed like the joints. Undefined when the source has no fingertip
   * data (so a cursor renderer can hide it). Matches `joints.leftHand`.
   */
  readonly leftFingertip?: [number, number] | undefined;
  /** Precise right index-fingertip (0..1), or undefined when absent. */
  readonly rightFingertip?: [number, number] | undefined;
  /**
   * Whether each hand is currently tracked. `undefined` means "always active" — the
   * phone (Vision) and keyboard controllers always provide both hands, so they leave
   * these unset. The webcam controller sets them `false` when a hand isn't seen, so a
   * game can hide/disable that blade instead of leaving a frozen one in play.
   */
  readonly leftHandActive?: boolean | undefined;
  readonly rightHandActive?: boolean | undefined;
  /** 0..1 aggregate confidence, blended with staleness. */
  readonly trackingQuality: number;
  /** Health classification the readiness gate + game pause read. */
  readonly health: TrackingHealth;
  /** True if all required joints are currently usable. */
  readonly hasRequiredJoints: boolean;
  /** ms since the last usable input arrived. */
  readonly ageMs: number;

  /** Advance internal timers; called once per frame with wall-clock ms. */
  tick(nowMs: number): void;
  /** Free listeners/timers. */
  dispose(): void;
}

/** Required joints for the game to be playable. */
const REQUIRED_JOINTS: (keyof Joints)[] = [
  "head",
  "leftHand",
  "rightHand",
  "torso",
];

const STALE_MS = 400;
/** Exponential smoothing factor per received packet (higher = snappier). */
const SMOOTH_ALPHA = 0.5;
/**
 * How many consecutive packets an OPTIONAL arm joint may be absent before we drop
 * it back to undefined. Vision occasionally omits a joint for a frame or two;
 * holding the last smoothed value briefly avoids a flicker between the real bent
 * arm and the derived fallback, without fabricating a joint that's truly gone.
 */
const ARM_ABSENCE_GRACE = 5;

function lerpPoint(a: [number, number], b: Vec2, t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function neutralJoints(): Joints {
  return {
    head: [0.5, 0.18],
    leftHand: [0.32, 0.5],
    rightHand: [0.68, 0.5],
    torso: [0.5, 0.5],
    leftKnee: [0.42, 0.72],
    rightKnee: [0.58, 0.72],
    leftFoot: [0.42, 0.95],
    rightFoot: [0.58, 0.95],
  };
}

/**
 * Shared pose-processing core for controllers fed by real pose frames — whether
 * they arrive over the socket relay (`PoseController`) or in-process from native
 * code via the JS bridge (`BridgeController`). Both transports carry the exact
 * same `PosePacket` shape, so ALL of the control-feel logic lives here, once:
 * - out-of-order rejection (discard packets with seq <= last seq),
 * - exponential smoothing of each joint,
 * - stale detection (>400ms since a fresh packet → mark stale),
 * - derived squat/lean from smoothed joints, calibrated against a neutral pose,
 * - health classification the readiness gate + game pause read.
 *
 * Subclasses add only their transport wiring (subscribe/dispose); they consume
 * frames through the shared `ingest()`.
 */
export abstract class PoseControllerBase implements BodyController {
  joints: Joints = neutralJoints();
  squatAmount = 0;
  leanAmount = 0;
  // Default open (1) so nothing grabs before real hand data arrives.
  leftHandOpen = 1;
  rightHandOpen = 1;
  // Undefined until precise fingertip data arrives; cleared again after a dropout.
  leftFingertip: [number, number] | undefined = undefined;
  rightFingertip: [number, number] | undefined = undefined;
  trackingQuality = 0;
  health: TrackingHealth = "no_signal";
  hasRequiredJoints = false;
  ageMs = Infinity;

  private lastSeq = -1;
  private lastRecvMs = -Infinity;
  private rawQuality = 0;
  private nowMs = 0;

  // Per-optional-arm-joint absence counter. 0 = present this packet; once it
  // exceeds ARM_ABSENCE_GRACE the joint is cleared to undefined on `joints`.
  private armAbsent: Record<string, number> = Object.fromEntries(
    ARM_JOINT_NAMES.map((n) => [n, ARM_ABSENCE_GRACE + 1]),
  );

  // Per-fingertip absence counter, same brief-dropout tolerance as the arm joints:
  // hold the last smoothed fingertip for a short grace window before clearing it to
  // undefined (so the cursor hides only when the fingertip is genuinely gone).
  private fingertipAbsent: Record<"left" | "right", number> = {
    left: ARM_ABSENCE_GRACE + 1,
    right: ARM_ABSENCE_GRACE + 1,
  };

  // Standing torso-Y baseline captured once when the first good pose arrives.
  private standTorsoY: number | null = null;

  /** Feed one pose frame. Rejects stale/out-of-order packets. */
  ingest(p: PosePacket): void {
    if (p.seq <= this.lastSeq) return; // out-of-order / duplicate
    this.lastSeq = p.seq;
    this.lastRecvMs = this.nowMs;
    this.rawQuality = clamp01(p.quality);

    // Smooth each required joint toward the incoming target. Required joints are
    // always present on both `this.joints` and the packet (validated upstream).
    const next = {} as Joints;
    for (const name of JOINT_NAMES) {
      const cur = this.joints[name] as [number, number];
      const target = p.joints[name] as [number, number];
      next[name] = lerpPoint(cur, target, SMOOTH_ALPHA);
    }

    // Smooth the OPTIONAL arm joints when the packet includes them. If a packet
    // omits one (undefined), don't fabricate it: hold the last smoothed value
    // for a short grace window (Vision may drop a joint for a frame), then clear
    // to undefined so renderers fall back to the derived arm.
    for (const name of ARM_JOINT_NAMES) {
      const incoming = p.joints[name];
      if (incoming) {
        const prev = this.joints[name];
        next[name] = prev
          ? lerpPoint(prev, incoming, SMOOTH_ALPHA)
          : [incoming[0], incoming[1]];
        this.armAbsent[name] = 0;
      } else {
        this.armAbsent[name] = (this.armAbsent[name] ?? 0) + 1;
        // Within grace: keep holding the last smoothed value. Past it: drop
        // (leave `next[name]` undefined) so renderers fall back.
        if ((this.armAbsent[name] ?? 0) <= ARM_ABSENCE_GRACE) {
          const held = this.joints[name];
          if (held) next[name] = held;
        }
      }
    }

    this.joints = next;

    // Smooth hand openness. Absent `hands` → treat as fully open (1) so a packet
    // without hand data can never trigger a grab.
    const targetLeft = p.hands ? clamp01(p.hands.left) : 1;
    const targetRight = p.hands ? clamp01(p.hands.right) : 1;
    this.leftHandOpen += (targetLeft - this.leftHandOpen) * SMOOTH_ALPHA;
    this.rightHandOpen += (targetRight - this.rightHandOpen) * SMOOTH_ALPHA;

    // Smooth the OPTIONAL precise fingertips, same brief-dropout tolerance as the
    // arm joints: hold the last smoothed value for a short grace window when a
    // packet omits one, then clear to undefined so the cursor hides.
    this.leftFingertip = this.smoothFingertip(
      "left",
      this.leftFingertip,
      p.fingertips?.left,
    );
    this.rightFingertip = this.smoothFingertip(
      "right",
      this.rightFingertip,
      p.fingertips?.right,
    );

    this.captureCalibration();
    this.deriveGestures();
  }

  /**
   * Smooth one optional fingertip toward its incoming target. Present → EMA from
   * the last value. Absent → hold the last smoothed value for ARM_ABSENCE_GRACE
   * packets, then return undefined so the cursor hides.
   */
  private smoothFingertip(
    which: "left" | "right",
    prev: [number, number] | undefined,
    incoming: [number, number] | undefined,
  ): [number, number] | undefined {
    if (incoming) {
      this.fingertipAbsent[which] = 0;
      return prev
        ? lerpPoint(prev, incoming, SMOOTH_ALPHA)
        : [incoming[0], incoming[1]];
    }
    this.fingertipAbsent[which] += 1;
    if (this.fingertipAbsent[which] <= ARM_ABSENCE_GRACE) return prev;
    return undefined;
  }

  private captureCalibration(): void {
    if (this.standTorsoY === null) {
      // First good frame defines the standing reference.
      this.standTorsoY = this.joints.torso[1];
    }
  }

  private deriveGestures(): void {
    const torso = this.joints.torso;
    const head = this.joints.head;

    // Lean: torso x offset from center, scaled. Center is 0.5.
    this.leanAmount = clampSigned((torso[0] - 0.5) / 0.28);

    // Squat: torso drops toward the feet. Use head-to-feet compression as a
    // robust proxy, falling back to torso-y descent from the standing baseline.
    const feetY = (this.joints.leftFoot[1] + this.joints.rightFoot[1]) / 2;
    const headToFeet = feetY - head[1]; // smaller when crouched
    const standRef = this.standTorsoY ?? torso[1];
    const torsoDrop = torso[1] - standRef; // positive when lower

    // Blend two signals for robustness. Normalize into 0..1.
    const byCompression = clamp01((0.72 - headToFeet) / 0.22);
    const byDrop = clamp01(torsoDrop / 0.14);
    this.squatAmount = clamp01(Math.max(byCompression, byDrop));
  }

  tick(nowMs: number): void {
    this.nowMs = nowMs;
    this.ageMs = nowMs - this.lastRecvMs;

    const required = this.checkRequired();
    this.hasRequiredJoints = required;

    if (this.lastRecvMs === -Infinity) {
      this.health = "no_signal";
      this.trackingQuality = 0;
    } else if (this.ageMs > STALE_MS) {
      this.health = "stale";
      // Decay quality as it goes staler.
      this.trackingQuality = Math.max(
        0,
        this.rawQuality * (1 - (this.ageMs - STALE_MS) / 1000),
      );
    } else if (this.rawQuality < 0.4 || !required) {
      this.health = "low_quality";
      this.trackingQuality = this.rawQuality;
    } else {
      this.health = "ok";
      this.trackingQuality = this.rawQuality;
    }
  }

  private checkRequired(): boolean {
    if (this.lastRecvMs === -Infinity) return false;
    for (const name of REQUIRED_JOINTS) {
      const [x, y] = this.joints[name] as [number, number];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return false;
    }
    return true;
  }

  /** Free transport listeners/timers. Base has none; subclasses override. */
  dispose(): void {
    // no external resources in the shared core
  }
}

/**
 * Live controller fed by inbound pose packets over the socket relay. All of the
 * smoothing / stale-rejection / gesture-derivation lives in `PoseControllerBase`;
 * this class is just the socket-facing entry point.
 */
export class PoseController extends PoseControllerBase {}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function clampSigned(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}
