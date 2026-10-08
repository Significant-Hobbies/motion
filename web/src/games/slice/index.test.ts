import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BodyController } from "../../sdk";
import { Slice } from ".";

const FRAME_MS = 1000 / 60;

type Hand = { x: number; y: number; active?: boolean };

function body(left: Hand, right: Hand): BodyController {
  return {
    joints: {
      head: [0.5, 0.18],
      leftHand: [left.x, left.y],
      rightHand: [right.x, right.y],
      torso: [0.5, 0.5],
      leftKnee: [0.42, 0.72],
      rightKnee: [0.58, 0.72],
      leftFoot: [0.42, 0.95],
      rightFoot: [0.58, 0.95],
    },
    squatAmount: 0,
    leanAmount: 0,
    leftHandOpen: 1,
    rightHandOpen: 1,
    leftHandActive: left.active,
    rightHandActive: right.active,
    trackingQuality: 1,
    health: "ok",
    hasRequiredJoints: true,
    ageMs: 0,
    tick: () => undefined,
    dispose: () => undefined,
  };
}

/** Swipe the left hand up and down through column `x` every frame (a fast blade). */
function swipe(game: Slice, seconds: number, x: number, active = true): void {
  const parked = { x: 0.9, y: 0.1 };
  for (let f = 0; f < seconds * 60; f++) {
    const y = f % 2 === 0 ? 0.1 : 1.1;
    game.update(FRAME_MS, body({ x, y, active }, parked));
  }
}

function stat(game: Slice, label: string): string | undefined {
  return game.result().stats?.find((s) => s.label === label)?.value;
}

describe("Slice", () => {
  let game: Slice;

  beforeEach(() => {
    game = new Slice();
    game.init({ width: 1280, height: 720 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slices fruit a fast swipe passes through", () => {
    // random 0.5 → every fruit launches straight up the x=0.5 column; no bombs.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    swipe(game, 4, 0.5);

    expect(Number(stat(game, "sliced"))).toBeGreaterThan(0);
    expect(game.result().score).toBeGreaterThan(0);
    expect(game.isOver()).toBe(false);
  });

  it("loses a life for every fruit that falls unsliced", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    swipe(game, 12, 0.05); // blade nowhere near the fruit column
    expect(stat(game, "sliced")).toBe("0");
    expect(game.isOver()).toBe(true);
  });

  it("costs a life when the blade hits a bomb", () => {
    // random 0.05 → each wave is one fruit plus one bomb near x≈0.18.
    vi.spyOn(Math, "random").mockReturnValue(0.05);
    swipe(game, 8, 0.176);
    expect(Number(stat(game, "sliced"))).toBeGreaterThan(0);
    expect(game.isOver()).toBe(true);
  });

  it("cannot slice with an untracked hand", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    swipe(game, 2, 0.5, false);
    expect(stat(game, "sliced")).toBe("0");
  });

  it("resets score and lives", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    swipe(game, 12, 0.05);
    game.reset();
    expect(game.isOver()).toBe(false);
    expect(game.result()).toEqual({
      score: 0,
      stats: [
        { label: "sliced", value: "0" },
        { label: "best combo", value: "0×" },
      ],
    });
  });
});
