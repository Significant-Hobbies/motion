// Readiness gate: the checklist that must pass before a game can start.
//
// Conditions:
//  - peer (controller) connected                     [auto-pass in debug]
//  - required joints visible                         [mouse move in debug]
//  - tracking quality acceptable, continuously ≥1.5s [mouse move in debug]
//  - calibration `done` received                     [auto-pass in debug]
//
// Exposes per-condition pass/fail so the UI can show exactly what's missing.

import type { BodyController } from "./controller";
import type { Room } from "./room";

const QUALITY_MIN = 0.55;
const CONTINUOUS_MS = 1500;

export interface ReadinessState {
  peer: boolean;
  joints: boolean;
  quality: boolean; // held continuously long enough
  calibrated: boolean;
  ready: boolean;
  /** 0..1 progress of the continuous-quality hold. */
  qualityHold: number;
}

export class Readiness {
  private goodSince = -1;
  private calibDone = false;

  constructor(
    private room: Room,
    private debug: boolean,
  ) {
    if (!debug) {
      room.on("calib", (c) => {
        if (c.stage === "done") this.calibDone = true;
      });
    }
  }

  /** In debug we still require *some* movement (health becomes ok on mouse move). */
  evaluate(body: BodyController, nowMs: number): ReadinessState {
    const peer = this.debug ? true : this.room.peerConnected;
    const joints = body.hasRequiredJoints;
    const qualityNow =
      body.health === "ok" && body.trackingQuality >= (this.debug ? 0.1 : QUALITY_MIN);

    if (qualityNow && joints && peer) {
      if (this.goodSince < 0) this.goodSince = nowMs;
    } else {
      this.goodSince = -1;
    }

    const held = this.goodSince >= 0 ? nowMs - this.goodSince : 0;
    const quality = held >= CONTINUOUS_MS;
    const calibrated = this.debug ? true : this.calibDone;
    const ready = peer && joints && quality && calibrated;

    return {
      peer,
      joints,
      quality,
      calibrated,
      ready,
      qualityHold: Math.min(1, held / CONTINUOUS_MS),
    };
  }
}
