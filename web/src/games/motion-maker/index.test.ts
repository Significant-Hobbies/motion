import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BodyController } from "../../sdk";
import { MotionMaker } from ".";

const FRAME_MS = 1000 / 60;

/** Left hand at (x, y) with openness `open`; the right hand rests far away, open. */
function body(x: number, y: number, open: number): BodyController {
  return {
    joints: {
      head: [0.5, 0.18],
      leftHand: [x, y],
      rightHand: [0.95, 0.05],
      torso: [0.5, 0.5],
      leftKnee: [0.42, 0.72],
      rightKnee: [0.58, 0.72],
      leftFoot: [0.42, 0.95],
      rightFoot: [0.58, 0.95],
    },
    squatAmount: 0,
    leanAmount: 0,
    leftHandOpen: open,
    rightHandOpen: 1,
    trackingQuality: 1,
    health: "ok",
    hasRequiredJoints: true,
    ageMs: 0,
    tick: () => undefined,
    dispose: () => undefined,
  };
}

function hold(game: MotionMaker, frames: number, input: BodyController): void {
  for (let f = 0; f < frames; f++) game.update(FRAME_MS, input);
}

/** Open the hand at (x, y) to arm it, then close it to grab. */
function grabAt(game: MotionMaker, x: number, y: number): void {
  hold(game, 3, body(x, y, 1));
  hold(game, 3, body(x, y, 0));
}

function stat(game: MotionMaker, label: string): string | undefined {
  return game.result().stats?.find((s) => s.label === label)?.value;
}

describe("MotionMaker", () => {
  let game: MotionMaker;

  beforeEach(() => {
    // random 0.5 → every ball spawns at (0.5, 0.29) with no drift.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    game = new MotionMaker();
    game.init({ width: 1280, height: 720 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never ends: it is a live mirror", () => {
    hold(game, 600, body(0.5, 0.5, 1));
    expect(game.isOver()).toBe(false);
  });

  it("scores a ball carried into the bin and released", () => {
    grabAt(game, 0.5, 0.29);
    // Carry it down to the bin, then let the hand settle so the release is gentle.
    for (let y = 0.29; y <= 0.82; y += 0.01)
      game.update(FRAME_MS, body(0.5, y, 0));
    hold(game, 30, body(0.5, 0.82, 0));
    hold(game, 5, body(0.5, 0.82, 1));

    expect(stat(game, "dropped in bin")).toBe("1");
    expect(game.result().score).toBe(100);
  });

  it("does not grab without a deliberate open→close gesture", () => {
    // Starts closed (never armed) over the balls, then carries "them" to the bin.
    hold(game, 3, body(0.5, 0.29, 0));
    for (let y = 0.29; y <= 0.82; y += 0.01)
      game.update(FRAME_MS, body(0.5, y, 0));
    hold(game, 30, body(0.5, 0.82, 1));
    expect(stat(game, "dropped in bin")).toBe("0");
  });

  it("slices balls with a swung sword", () => {
    grabAt(game, 0.16, 0.6); // the sword rests at (0.16, 0.6)
    for (let x = 0.16; x <= 0.9; x += 0.05)
      game.update(FRAME_MS, body(x, 0.29, 0));

    expect(Number(stat(game, "sliced"))).toBeGreaterThan(0);
    expect(game.result().score).toBeGreaterThanOrEqual(150);
  });

  it("resets the score and respawns objects", () => {
    grabAt(game, 0.16, 0.6);
    for (let x = 0.16; x <= 0.9; x += 0.05)
      game.update(FRAME_MS, body(x, 0.29, 0));
    game.reset();
    expect(game.result().score).toBe(0);
    expect(stat(game, "sliced")).toBe("0");
  });
});
