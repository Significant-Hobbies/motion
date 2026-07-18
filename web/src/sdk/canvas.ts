// Responsive 16:9 canvas with devicePixelRatio scaling and a letterboxed play
// area. All game/skeleton drawing happens against the play-area rect so layout
// is resolution-independent (720p → 4K).

const ASPECT = 16 / 9;

export interface PlayArea {
  /** Top-left of the 16:9 letterboxed area, in CSS pixels. */
  x: number;
  y: number;
  /** Size of the play area, in CSS pixels. */
  w: number;
  h: number;
}

export class CanvasSurface {
  readonly ctx: CanvasRenderingContext2D;
  play: PlayArea = { x: 0, y: 0, w: 0, h: 0 };
  dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", this.resize);
  }

  resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.dpr = dpr;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    // Letterbox a 16:9 play area centered in the viewport.
    let w = cssW;
    let h = cssW / ASPECT;
    if (h > cssH) {
      h = cssH;
      w = cssH * ASPECT;
    }
    this.play = {
      x: (cssW - w) / 2,
      y: (cssH - h) / 2,
      w,
      h,
    };
  };

  /** Begin a frame: reset transform to CSS-pixel space and clear. */
  begin(): void {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

    // Draw the letterbox bars implicitly via the darker background; fill play area.
    const p = this.play;
    ctx.fillStyle = "#070b16";
    ctx.fillRect(p.x, p.y, p.w, p.h);
  }

  /** Map normalized 0..1 coords into play-area CSS pixels. */
  toPx(nx: number, ny: number): [number, number] {
    return [this.play.x + nx * this.play.w, this.play.y + ny * this.play.h];
  }

  /** Scale a normalized length (x-relative) to play-area pixels. */
  sx(n: number): number {
    return n * this.play.w;
  }
  sy(n: number): number {
    return n * this.play.h;
  }

  dispose(): void {
    window.removeEventListener("resize", this.resize);
  }
}
