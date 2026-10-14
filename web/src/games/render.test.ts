import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasSurface } from "../sdk/canvas";
import { CanvasRenderer, type Game } from "../sdk/game";
import type { BodyController } from "../sdk/controller";
import { MotionMaker } from "./motion-maker";
import { ReachDodge } from "./reach-dodge";
import { Slice } from "./slice";

type Command = {
  op: string;
  args: (number | string)[];
  fill: string;
  stroke: string;
  alpha: number;
};
/** Canvas double records observable draws and enforces finite geometry and balanced state. */
class DrawingContext {
  fillStyle = "initial-fill";
  strokeStyle = "initial-stroke";
  globalAlpha = 1;
  lineWidth = 1;
  font = "initial-font";
  readonly commands: Command[] = [];
  private states: {
    fillStyle: string;
    strokeStyle: string;
    globalAlpha: number;
    lineWidth: number;
    font: string;
  }[] = [];
  get depth() {
    return this.states.length;
  }
  save() {
    this.states.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      globalAlpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      font: this.font,
    });
  }
  restore() {
    const state = this.states.pop();
    if (!state) throw new Error("Unbalanced canvas restore");
    Object.assign(this, state);
  }
  private record(op: string, args: (number | string)[]) {
    for (const arg of args)
      if (typeof arg === "number" && !Number.isFinite(arg))
        throw new Error(`Nonfinite ${op} geometry`);
    this.commands.push({
      op,
      args,
      fill: this.fillStyle,
      stroke: this.strokeStyle,
      alpha: this.globalAlpha,
    });
  }
  beginPath() {}
  closePath() {}
  setTransform(...args: number[]) {
    this.record("setTransform", args);
  }
  setLineDash(...args: number[][]) {
    this.record("dash", args.flat());
  }
  moveTo(...args: number[]) {
    this.record("move", args);
  }
  lineTo(...args: number[]) {
    this.record("line", args);
  }
  arc(...args: number[]) {
    if (args[2]! < 0) throw new Error("Negative radius");
    this.record("arc", args);
  }
  arcTo(...args: number[]) {
    this.record("arcTo", args);
  }
  fillRect(...args: number[]) {
    this.record("rect", args);
  }
  fillText(text: string, ...args: number[]) {
    this.record("text", [text, ...args]);
  }
  fill() {
    this.record("fill", []);
  }
  stroke() {
    this.record("stroke", []);
  }
  translate(...args: number[]) {
    this.record("translate", args);
  }
  rotate(...args: number[]) {
    this.record("rotate", args);
  }
}

function input(x = 0.9, y = 0.1, open = 1): BodyController {
  return {
    joints: {
      head: [0.5, 0.18],
      torso: [0.5, 0.5],
      leftHand: [x, y],
      rightHand: [0.95, 0.05],
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
    tick: () => {},
    dispose: () => {},
  };
}

describe("rendered gameplay feedback and reset", () => {
  let ctx: DrawingContext;
  let surface: CanvasSurface;
  let renderer: CanvasRenderer;
  const dt = 1000 / 60;

  function advance(game: Game, frames: number, body = input()) {
    for (let i = 0; i < frames; i++) game.update(dt, body);
  }
  function draw(game: Game) {
    ctx.commands.length = 0;
    const before = game.result();
    game.render(renderer);
    expect(game.result()).toEqual(before);
    expect(ctx.depth).toBe(0);
    expect(ctx.fillStyle).toBe("initial-fill");
    expect(ctx.strokeStyle).toBe("initial-stroke");
    expect(ctx.globalAlpha).toBe(1);
    return ctx.commands;
  }
  function texts() {
    return ctx.commands.filter((c) => c.op === "text").map((c) => c.args[0]);
  }

  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        innerWidth: 1280,
        innerHeight: 900,
        devicePixelRatio: 1,
      })
    );
    ctx = new DrawingContext();
    surface = new CanvasSurface({
      getContext: () => ctx,
      style: {},
    } as unknown as HTMLCanvasElement);
    renderer = new CanvasRenderer(surface);
  });
  afterEach(() => {
    surface.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("projects the Motion Maker avatar into the play area, shows held-object feedback and restores its idle scene on reset", () => {
    const game = new MotionMaker();
    game.init({ width: 1280, height: 720 });
    draw(game);
    expect(texts()).toContain("0000");
    expect(texts()).toContain("DROP HERE");
    const body = input(-2, 2, 0);
    body.joints.leftElbow = [0.1, 0.3];
    advance(game, 1, body);
    draw(game);
    expect(
      ctx.commands.some(
        (c) =>
          c.op === "arc" &&
          c.fill === "#ff6b9d" &&
          c.args[0] === 0 &&
          c.args[1] === 810
      )
    ).toBe(true);
    expect(
      ctx.commands.some((c) => c.op === "fill" && c.fill === "#35e0c8")
    ).toBe(true);
    advance(game, 3, input(0.5, 0.29));
    advance(game, 3, input(0.5, 0.29, 0));
    draw(game);
    expect(
      ctx.commands.some(
        (c) => c.op === "stroke" && c.stroke === "rgba(255,255,255,0.9)"
      )
    ).toBe(true);
    game.reset();
    draw(game);
    expect(texts()).toContain("0000");
    expect(
      ctx.commands.some(
        (c) => c.op === "stroke" && c.stroke === "rgba(255,255,255,0.9)"
      )
    ).toBe(false);
  });

  it("renders sword-slice feedback and the earned score from actual Motion Maker input", () => {
    const game = new MotionMaker();
    game.init({ width: 1280, height: 720 });
    advance(game, 3, input(0.16, 0.6));
    advance(game, 3, input(0.16, 0.6, 0));
    for (let x = 0.16; x <= 0.9; x += 0.05) game.update(dt, input(x, 0.29, 0));
    expect(game.result().score).toBeGreaterThanOrEqual(150);
    draw(game);
    expect(texts()).toContain(String(game.result().score).padStart(4, "0"));
    expect(
      ctx.commands.some(
        (c) => c.op === "stroke" && c.stroke.startsWith("rgba(120,200,255,")
      )
    ).toBe(true);
  });

  it("renders Reach & Dodge hit/clip feedback, low-time warning and a clean replay HUD", () => {
    vi.mocked(Math.random).mockReturnValue(0);
    const game = new ReachDodge();
    game.init({ width: 1280, height: 720 });
    const skeleton = vi.spyOn(renderer, "drawSkeleton");
    const body = input(0.16, 0.28);
    advance(game, 49, body);
    draw(game);
    expect(texts()).toContain("L");
    expect(texts()).toContain("00110");
    expect(skeleton).toHaveBeenLastCalledWith(
      body,
      expect.objectContaining({ handColor: "#ffffff" })
    );
    advance(game, 228, body);
    draw(game);
    expect(texts()).toContain("LEAN");
    expect(skeleton).toHaveBeenLastCalledWith(
      body,
      expect.objectContaining({ color: "#ff4d6d" })
    );
    expect(
      ctx.commands.some(
        (c) => c.op === "rect" && c.fill.startsWith("rgba(255,77,109,")
      )
    ).toBe(true);
    advance(game, 3300, body);
    draw(game);
    expect(
      ctx.commands.some((c) => c.op === "fill" && c.fill === "#ffcc33")
    ).toBe(true);
    game.reset();
    skeleton.mockClear();
    draw(game);
    expect(texts()).toContain("00000");
    expect(texts()).not.toContain("LEAN");
    expect(skeleton).not.toHaveBeenCalled();
    expect(
      ctx.commands.some((c) => c.op === "fill" && c.fill === "#35e0c8")
    ).toBe(true);
  });

  it("hides untracked Slice blades, renders slice debris and clears transient effects on reset", () => {
    const game = new Slice();
    game.init({ width: 1280, height: 720 });
    const absent = {
      ...input(),
      leftHandActive: false,
      rightHandActive: false,
    };
    advance(game, 2, absent);
    draw(game);
    expect(texts()).toContain("♥ ♥ ♥");
    expect(
      ctx.commands.some((c) => c.op === "stroke" && c.stroke === "#6b4a2b")
    ).toBe(false);
    for (let i = 0; i < 240 && game.result().score === 0; i++)
      game.update(dt, input(0.5, i % 2 ? 1.1 : 0.1));
    expect(game.result().score).toBeGreaterThan(0);
    draw(game);
    expect(texts()).toContain(String(game.result().score).padStart(4, "0"));
    expect(ctx.commands.some((c) => c.op === "rotate")).toBe(true);
    game.reset();
    draw(game);
    expect(texts()).toContain("0000");
    expect(texts()).toContain("♥ ♥ ♥");
    expect(ctx.commands.some((c) => c.op === "rotate")).toBe(false);
  });

  it("warns about Slice bombs and shows life loss/shake after a real blade collision", () => {
    vi.mocked(Math.random).mockReturnValue(0.05);
    const game = new Slice();
    game.init({ width: 1280, height: 720 });
    advance(game, 60);
    draw(game);
    expect(texts()).toContain("!");
    for (let i = 0; i < 120; i++) {
      game.update(dt, input(0.176, i % 2 ? 1.1 : 0.1));
      draw(game);
      if (texts().includes("♥ ♥ ♡")) break;
    }
    expect(texts()).toContain("♥ ♥ ♡");
    expect(ctx.commands.some((c) => c.op === "translate")).toBe(true);
    expect(
      ctx.commands.some(
        (c) => c.op === "rect" && c.fill.startsWith("rgba(255,70,70,")
      )
    ).toBe(true);
    game.reset();
    draw(game);
    expect(ctx.commands.some((c) => c.op === "translate")).toBe(false);
  });
});
