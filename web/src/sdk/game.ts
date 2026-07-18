// The Game contract + the Renderer implementation.
//
// A `Game` is the ONLY thing a new Motion title has to write. It reads input
// exclusively through the `BodyController` abstraction (never raw pose packets),
// draws through the `Renderer`, and reports when it's over plus a `GameResult`.
// Everything else — networking, readiness/calibration, the fixed-timestep loop,
// tracking-loss pause/resume, recording — is the GameHost's job (see index.ts /
// the createSession runner).

import type { CanvasSurface } from "./canvas";
import { drawSkeleton } from "./skeleton";
import type {
  BodyController,
  GameContext,
  GameResult,
  Renderer,
} from "./types";

export type { GameContext, GameResult, Renderer } from "./types";

/**
 * A drop-in Motion game. The host drives it with a fixed timestep and hands it
 * a `Renderer` each frame. Games must be deterministic under a fixed dt so the
 * recorded canvas matches what the player saw.
 */
export interface Game {
  readonly id: string;
  readonly name: string;
  /** Target session length in ms. The host also treats `isOver()` as truth. */
  readonly durationMs: number;

  /** Called once when the game screen is entered (and after reset()). */
  init(ctx: GameContext): void;
  /** Fixed-timestep update. `dtMs` is milliseconds. */
  update(dtMs: number, input: BodyController): void;
  /** Draw the current frame. */
  render(r: Renderer): void;
  /** True once the session has ended. */
  isOver(): boolean;
  /** Final score + summary for the results screen. */
  result(): GameResult;
  /** Reset all state to play again. */
  reset(): void;
  /** Optional teardown for external resources. */
  dispose?(): void;
}

/**
 * Concrete `Renderer` backed by the letterboxed `CanvasSurface`. Recreated (or
 * refreshed) each frame is unnecessary — it reads `surf.play` live — so one
 * instance per host is enough.
 */
export class CanvasRenderer implements Renderer {
  constructor(private surf: CanvasSurface) {}

  get ctx(): CanvasRenderingContext2D {
    return this.surf.ctx;
  }

  get area(): { x: number; y: number; w: number; h: number } {
    const p = this.surf.play;
    return { x: p.x, y: p.y, w: p.w, h: p.h };
  }

  toPx(nx: number, ny: number): [number, number] {
    return this.surf.toPx(nx, ny);
  }

  sx(n: number): number {
    return this.surf.sx(n);
  }

  sy(n: number): number {
    return this.surf.sy(n);
  }

  drawSkeleton(
    body: BodyController,
    opts?: { color?: string; handColor?: string; alpha?: number },
  ): void {
    drawSkeleton(this.surf, body, opts ?? {});
  }
}
