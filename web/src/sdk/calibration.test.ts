import { describe, expect, it } from "vitest";

import type { BodyController } from "./controller";
import { Readiness } from "./calibration";
import type { Room } from "./room";

function body(overrides: Partial<BodyController> = {}): BodyController {
  return {
    joints: {
      head: [0.5, 0.2],
      leftHand: [0.3, 0.5],
      rightHand: [0.7, 0.5],
      torso: [0.5, 0.5],
      leftKnee: [0.4, 0.7],
      rightKnee: [0.6, 0.7],
      leftFoot: [0.4, 0.9],
      rightFoot: [0.6, 0.9],
    },
    squatAmount: 0,
    leanAmount: 0,
    leftHandOpen: 1,
    rightHandOpen: 1,
    trackingQuality: 0.9,
    health: "ok",
    hasRequiredJoints: true,
    ageMs: 0,
    tick: () => undefined,
    dispose: () => undefined,
    ...overrides,
  };
}

describe("Readiness", () => {
  it("requires an uninterrupted quality hold in debug mode", () => {
    const readiness = new Readiness({} as Room, true);

    expect(readiness.evaluate(body(), 0).ready).toBe(false);
    expect(readiness.evaluate(body(), 750).qualityHold).toBe(0.5);
    expect(readiness.evaluate(body(), 1500)).toMatchObject({
      peer: true,
      joints: true,
      quality: true,
      calibrated: true,
      ready: true,
    });

    expect(readiness.evaluate(body({ health: "stale" }), 1600).ready).toBe(
      false
    );
    expect(readiness.evaluate(body(), 1700).qualityHold).toBe(0);
  });

  it("waits for both the peer and calibration outside debug mode", () => {
    let calibrationListener: ((message: { stage: string }) => void) | undefined;
    const room = {
      peerConnected: false,
      on: (event: string, listener: (message: { stage: string }) => void) => {
        if (event === "calib") calibrationListener = listener;
      },
    } as unknown as Room;
    const readiness = new Readiness(room, false);

    expect(readiness.evaluate(body(), 0).peer).toBe(false);
    room.peerConnected = true;
    calibrationListener?.({ stage: "done" });
    readiness.evaluate(body(), 100);

    expect(readiness.evaluate(body(), 1600).ready).toBe(true);
  });
});
