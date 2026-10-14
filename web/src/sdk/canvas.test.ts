import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasSurface } from "./canvas";

describe("CanvasSurface lifecycle", () => {
  let win: EventTarget & {
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
  };
  let surface: CanvasSurface | undefined;

  beforeEach(() => {
    win = Object.assign(new EventTarget(), {
      innerWidth: 390,
      innerHeight: 768,
      devicePixelRatio: 4,
    });
    vi.stubGlobal("window", win);
  });

  afterEach(() => {
    surface?.dispose();
    surface = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("letterboxes across resize, caps DPR, draws in CSS pixels and releases its listener", () => {
    const fills: { color: string; rect: number[] }[] = [];
    const ctx = {
      fillStyle: "",
      setTransform: vi.fn(),
      fillRect: (...rect: number[]) =>
        fills.push({ color: ctx.fillStyle, rect }),
    };
    const canvas = {
      width: 0,
      height: 0,
      style: {},
      getContext: vi.fn(() => ctx),
    };
    surface = new CanvasSurface(canvas as unknown as HTMLCanvasElement);
    expect(canvas.getContext).toHaveBeenCalledWith("2d", { alpha: false });
    expect([canvas.width, canvas.height, surface.dpr]).toEqual([1170, 2304, 3]);
    expect(canvas.style).toEqual({ width: "390px", height: "768px" });
    expect(surface.play.w / surface.play.h).toBeCloseTo(16 / 9);
    expect(surface.play.x).toBe(0);
    expect(surface.play.y).toBeCloseTo((768 - (390 * 9) / 16) / 2);
    expect(surface.toPx(0.5, 0.5)).toEqual([195, 384]);
    expect(surface.sx(1)).toBe(390);
    expect(surface.sy(1)).toBeCloseTo((390 * 9) / 16);

    Object.assign(win, {
      innerWidth: 1440,
      innerHeight: 600,
      devicePixelRatio: 0,
    });
    win.dispatchEvent(new Event("resize"));
    expect([canvas.width, canvas.height, surface.dpr]).toEqual([1440, 600, 1]);
    expect(surface.play.x).toBeCloseTo((1440 - (600 * 16) / 9) / 2);
    expect(surface.play.w).toBeCloseTo((600 * 16) / 9);
    expect([surface.play.y, surface.play.h]).toEqual([0, 600]);
    surface.begin();
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(fills).toEqual([
      { color: "#05070d", rect: [0, 0, 1440, 600] },
      { color: "#070b16", rect: [surface.play.x, 0, surface.play.w, 600] },
    ]);
    surface.dispose();
    Object.assign(win, { innerWidth: 768, innerHeight: 390 });
    win.dispatchEvent(new Event("resize"));
    expect([canvas.width, canvas.height]).toEqual([1440, 600]);
  });

  it("fails before acquiring a resize listener when a context is unavailable", () => {
    const listen = vi.spyOn(win, "addEventListener");
    expect(
      () =>
        new CanvasSurface({
          getContext: () => null,
        } as unknown as HTMLCanvasElement)
    ).toThrow("2D canvas context unavailable");
    expect(listen).not.toHaveBeenCalled();
  });
});
