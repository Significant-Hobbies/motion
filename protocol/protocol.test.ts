import { describe, expect, it } from "vitest";

import {
  CODE_LENGTH,
  isPosePacket,
  isValidRoomCode,
  makeRoomCode,
  parseMessage,
  type Joints,
} from "./protocol";

const joints: Joints = {
  head: [0.5, 0.2],
  leftHand: [0.3, 0.5],
  rightHand: [0.7, 0.5],
  torso: [0.5, 0.5],
  leftKnee: [0.4, 0.7],
  rightKnee: [0.6, 0.7],
  leftFoot: [0.4, 0.9],
  rightFoot: [0.6, 0.9],
};

describe("room codes", () => {
  it("generates an unambiguous fixed-length code", () => {
    const code = makeRoomCode(() => 0);

    expect(code).toBe("2".repeat(CODE_LENGTH));
    expect(isValidRoomCode(code)).toBe(true);
  });

  it("accepts lowercase but rejects ambiguous and malformed codes", () => {
    expect(isValidRoomCode("bcdfgh")).toBe(true);
    expect(isValidRoomCode("BCDFG0")).toBe(false);
    expect(isValidRoomCode("BCDFG")).toBe(false);
  });
});

describe("wire validation", () => {
  it("accepts a complete finite pose packet", () => {
    expect(
      isPosePacket({
        v: 1,
        type: "pose",
        seq: 1,
        sentAt: 25,
        quality: 0.9,
        joints,
      })
    ).toBe(true);
  });

  it("rejects missing joints and non-finite coordinates", () => {
    const { rightFoot: _rightFoot, ...missingJoint } = joints;
    const invalidCoordinate = { ...joints, head: [Number.NaN, 0.2] };

    expect(
      isPosePacket({
        v: 1,
        type: "pose",
        seq: 1,
        sentAt: 25,
        quality: 0.9,
        joints: missingJoint,
      })
    ).toBe(false);
    expect(
      isPosePacket({
        v: 1,
        type: "pose",
        seq: 1,
        sentAt: 25,
        quality: 0.9,
        joints: invalidCoordinate,
      })
    ).toBe(false);
  });

  it("parses object messages and rejects malformed input", () => {
    expect(parseMessage('{"v":1,"type":"ping","t":42}')).toEqual({
      v: 1,
      type: "ping",
      t: 42,
    });
    expect(parseMessage("not json")).toBeNull();
    expect(parseMessage("[]")).toBeNull();
    expect(parseMessage('{"v":1}')).toBeNull();
  });
});
