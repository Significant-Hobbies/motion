import { describe, expect, it } from "vitest";

import type { Joints, PosePacket } from "../../../protocol/protocol";
import { clamp01, clampSigned, PoseController } from "./controller";

const joints: Joints = {
  head: [0.5, 0.2],
  leftHand: [0.3, 0.5],
  rightHand: [0.7, 0.5],
  torso: [0.6, 0.5],
  leftKnee: [0.4, 0.7],
  rightKnee: [0.6, 0.7],
  leftFoot: [0.4, 0.9],
  rightFoot: [0.6, 0.9],
};

function packet(overrides: Partial<PosePacket> = {}): PosePacket {
  return {
    v: 1,
    type: "pose",
    seq: 1,
    sentAt: 0,
    quality: 0.8,
    joints,
    ...overrides,
  };
}

describe("PoseController", () => {
  it("moves from no signal to healthy and then stale", () => {
    const controller = new PoseController();

    controller.tick(0);
    expect(controller.health).toBe("no_signal");

    controller.ingest(packet());
    controller.tick(10);
    expect(controller.health).toBe("ok");
    expect(controller.hasRequiredJoints).toBe(true);
    expect(controller.trackingQuality).toBe(0.8);
    expect(controller.leanAmount).toBeCloseTo(0.1786, 3);

    controller.tick(500);
    expect(controller.health).toBe("stale");
    expect(controller.ageMs).toBe(500);
    expect(controller.trackingQuality).toBeCloseTo(0.72);

    controller.tick(1400);
    expect(controller.trackingQuality).toBe(0);
    controller.ingest(packet({ seq: 2 }));
    controller.tick(1401);
    expect(controller.health).toBe("ok");
    expect(controller.trackingQuality).toBe(0.8);
  });

  it("rejects duplicate packets and clamps hand confidence", () => {
    const controller = new PoseController();
    controller.tick(0);
    controller.ingest(packet({ hands: { left: -2, right: 3 } }));
    const torsoAfterFirstPacket = controller.joints.torso;

    controller.ingest(
      packet({
        hands: { left: 1, right: 0 },
        joints: { ...joints, torso: [1, 1] },
      })
    );

    expect(controller.joints.torso).toEqual(torsoAfterFirstPacket);
    expect(controller.leftHandOpen).toBe(0.5);
    expect(controller.rightHandOpen).toBe(1);
  });

  it("classifies low-confidence input", () => {
    const controller = new PoseController();
    controller.tick(0);
    controller.ingest(packet({ quality: 0.2 }));
    controller.tick(1);

    expect(controller.health).toBe("low_quality");
    expect(controller.trackingQuality).toBe(0.2);
  });

  it("holds intermittent arm and fingertip dropouts, then clears and reacquires them", () => {
    const controller = new PoseController();
    controller.tick(0);
    controller.ingest(
      packet({
        joints: { ...joints, leftElbow: [0.2, 0.4] },
        fingertips: { left: [0.1, 0.2] },
      })
    );
    expect(controller.joints.leftElbow).toEqual([0.2, 0.4]);
    expect(controller.leftFingertip).toEqual([0.1, 0.2]);

    for (let seq = 2; seq <= 6; seq++) {
      controller.ingest(packet({ seq }));
      expect(controller.joints.leftElbow).toEqual([0.2, 0.4]);
      expect(controller.leftFingertip).toEqual([0.1, 0.2]);
    }

    controller.ingest(packet({ seq: 7 }));
    expect(controller.joints.leftElbow).toBeUndefined();
    expect(controller.leftFingertip).toBeUndefined();

    controller.ingest(
      packet({
        seq: 8,
        joints: { ...joints, leftElbow: [0.3, 0.45] },
        fingertips: { left: [0.4, 0.5] },
      })
    );
    expect(controller.joints.leftElbow).toEqual([0.3, 0.45]);
    expect(controller.leftFingertip).toEqual([0.4, 0.5]);
  });
});

describe("numeric bounds", () => {
  it("clamps unsigned and signed values", () => {
    expect([clamp01(-1), clamp01(0.4), clamp01(2)]).toEqual([0, 0.4, 1]);
    expect([clampSigned(-2), clampSigned(0.4), clampSigned(2)]).toEqual([
      -1, 0.4, 1,
    ]);
  });
});
