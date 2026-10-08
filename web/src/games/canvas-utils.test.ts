import { describe, expect, it } from "vitest";

import type { BodyController, Renderer } from "../sdk";
import {
  beginScoreHud,
  distPointToSegment,
  handJoint,
  roundRect,
} from "./canvas-utils";

type Call = [string, ...unknown[]];

/** Records every 2D-context call and property write, in order. */
function recordingContext(calls: Call[]): CanvasRenderingContext2D {
  return new Proxy({} as CanvasRenderingContext2D, {
    get:
      (_t, prop) =>
      (...args: unknown[]) => {
        calls.push([String(prop), ...args]);
      },
    set: (_t, prop, value) => {
      calls.push([`=${String(prop)}`, value]);
      return true;
    },
  });
}

describe("distPointToSegment", () => {
  it("measures to the nearest point on the segment, clamped to its ends", () => {
    expect(distPointToSegment(0.5, 1, 0, 0, 1, 0)).toBeCloseTo(1);
    expect(distPointToSegment(-3, 4, 0, 0, 1, 0)).toBeCloseTo(5);
    expect(distPointToSegment(4, 4, 0, 0, 1, 0)).toBeCloseTo(5);
  });

  it("treats a zero-length segment as a point", () => {
    expect(distPointToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });
});

describe("roundRect", () => {
  it("clamps the radius to half the shortest side", () => {
    const calls: Call[] = [];
    roundRect(recordingContext(calls), 0, 0, 10, 4, 99);
    expect(calls[0]).toEqual(["beginPath"]);
    expect(calls[1]).toEqual(["moveTo", 2, 0]);
    expect(calls.filter(([name]) => name === "arcTo")).toHaveLength(4);
    expect(
      calls.every(([name, ...args]) => name !== "arcTo" || args[4] === 2)
    ).toBe(true);
    expect(calls.at(-1)).toEqual(["closePath"]);
  });
});

describe("handJoint", () => {
  it("returns the tracked hand joint for each side", () => {
    const body = {
      joints: { leftHand: [0.1, 0.2], rightHand: [0.8, 0.9] },
    } as unknown as BodyController;
    expect(handJoint(body, "left")).toEqual([0.1, 0.2]);
    expect(handJoint(body, "right")).toEqual([0.8, 0.9]);
  });
});

describe("beginScoreHud", () => {
  it("opens a saved HUD layer and draws the zero-padded score top-left", () => {
    const calls: Call[] = [];
    const renderer = {
      ctx: recordingContext(calls),
      area: { x: 10, y: 20, w: 1000, h: 500 },
      sx: (n: number) => n * 1000,
      sy: (n: number) => n * 500,
    } as unknown as Renderer;

    beginScoreHud(renderer, 42, 5);

    expect(calls).toEqual([
      ["save"],
      ["=textBaseline", "top"],
      ["=fillStyle", "#f4f7ff"],
      ["=font", "bold 50px system-ui"],
      ["=textAlign", "left"],
      ["fillText", "00042", 40, 35],
    ]);
  });
});
