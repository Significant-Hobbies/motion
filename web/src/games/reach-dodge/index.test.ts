import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Joints } from "../../../../protocol/protocol";
import type { BodyController } from "../../sdk";
import { ReachDodge } from ".";

const FRAME_MS = 1000 / 60;

function body(
  overrides: Partial<Joints> = {},
  squatAmount = 0
): BodyController {
  return {
    joints: {
      head: [0.5, 0.18],
      leftHand: [0.4, 0.95],
      rightHand: [0.6, 0.95],
      torso: [0.5, 0.5],
      leftKnee: [0.42, 0.72],
      rightKnee: [0.58, 0.72],
      leftFoot: [0.42, 0.95],
      rightFoot: [0.58, 0.95],
      ...overrides,
    },
    squatAmount,
    leanAmount: 0,
    leftHandOpen: 1,
    rightHandOpen: 1,
    trackingQuality: 1,
    health: "ok",
    hasRequiredJoints: true,
    ageMs: 0,
    tick: () => undefined,
    dispose: () => undefined,
  };
}

function play(game: ReachDodge, seconds: number, input: BodyController): void {
  for (let t = 0; t < seconds * 60; t++) game.update(FRAME_MS, input);
}

function stat(game: ReachDodge, label: string): string | undefined {
  return game.result().stats?.find((s) => s.label === label)?.value;
}

describe("ReachDodge", () => {
  let game: ReachDodge;

  beforeEach(() => {
    game = new ReachDodge();
    game.init({ width: 1280, height: 720 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scores a target when the matching hand reaches it", () => {
    // random 0 → targets spawn on the LEFT edge at (0.16, 0.28); obstacles in the high lane.
    vi.spyOn(Math, "random").mockReturnValue(0);
    play(game, 1, body({ leftHand: [0.16, 0.28] }));

    expect(Number(stat(game, "hits"))).toBeGreaterThan(0);
    expect(game.result().score).toBeGreaterThanOrEqual(110);
  });

  it("does not score a target reached by the wrong hand", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    play(game, 1, body({ rightHand: [0.16, 0.28] }));
    expect(stat(game, "hits")).toBe("0");
  });

  it("counts a dodge when the player leans out of a bar's path", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    play(game, 6, body({ torso: [0.8, 0.5] }));
    expect(Number(stat(game, "dodges"))).toBeGreaterThan(0);
  });

  it("clips a centered player and breaks the combo", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    play(game, 6, body());
    expect(stat(game, "dodges")).toBe("0");
    expect(stat(game, "best combo")).toBe("x0");
  });

  it("dodges a duck-lane bar only by squatting", () => {
    // random 0.99 → duck lane; targets spawn right (out of reach of the resting hands).
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    play(game, 6, body({}, 0.6));
    expect(Number(stat(game, "dodges"))).toBeGreaterThan(0);

    game.reset();
    play(game, 6, body({ torso: [0.8, 0.5] }, 0));
    expect(stat(game, "dodges")).toBe("0");
  });

  it("ends after the session length and resets cleanly", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    play(game, 76, body({ leftHand: [0.16, 0.28] }));
    expect(game.isOver()).toBe(true);
    const finalScore = game.result().score;
    game.update(FRAME_MS, body({ leftHand: [0.16, 0.28] }));
    expect(game.result().score).toBe(finalScore);

    game.reset();
    expect(game.isOver()).toBe(false);
    expect(game.result().score).toBe(0);
  });
});
