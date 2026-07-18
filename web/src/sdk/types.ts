// Shared SDK types.
//
// The Motion SDK is game-agnostic: it owns the room, the input controller, the
// fixed-timestep loop, the readiness/calibration handshake, tracking-loss
// pause/resume, results, and recording. A `Game` (see game.ts) is a drop-in
// consumer that reads ONLY the `BodyController` abstraction and draws through a
// `Renderer`. These are the shared types that cross the SDK ↔ game boundary.

import type { BodyController } from "./controller";

export type { BodyController } from "./controller";
export type { TrackingHealth, Vec2 } from "./controller";

/** Logical canvas size handed to a game at init. Normalized coords are 0..1. */
export interface GameContext {
  /** Play-area width in CSS pixels (letterboxed 16:9). */
  width: number;
  /** Play-area height in CSS pixels. */
  height: number;
}

/**
 * The draw surface a game renders through. A thin, stable wrapper over the
 * canvas so games never reach for the raw `CanvasSurface` internals: it exposes
 * the 2d context plus normalized→pixel helpers and a shared skeleton draw.
 */
export interface Renderer {
  /** The raw 2D context, already transformed to CSS-pixel space. */
  readonly ctx: CanvasRenderingContext2D;
  /** Play-area rect in CSS pixels. */
  readonly area: { x: number; y: number; w: number; h: number };
  /** Map normalized 0..1 coords into play-area CSS pixels. */
  toPx(nx: number, ny: number): [number, number];
  /** Scale a normalized x-relative length to pixels. */
  sx(n: number): number;
  /** Scale a normalized y-relative length to pixels. */
  sy(n: number): number;
  /** Draw the player's body skeleton (the shared avatar). */
  drawSkeleton(
    body: BodyController,
    opts?: { color?: string; handColor?: string; alpha?: number },
  ): void;
}

/** A game's final summary. `score` is the headline; `stats` are labeled extras. */
export interface GameResult {
  score: number;
  /** Ordered, labeled secondary stats for the results screen. */
  stats: { label: string; value: string }[];
}

/** Which host screen is currently showing. */
export type SessionScreen =
  | "pairing"
  | "mirror"
  | "readiness"
  | "game"
  | "results"
  // Bridge (embedded/v1) mode: waiting for native to call start(). Pairing,
  // mirror, and the readiness checklist are all handled on the phone.
  | "bridge-idle";

/** Recording lifecycle state, surfaced for diagnostics/UI. */
export type RecordingState =
  | "idle"
  | "recording"
  | "transferring"
  | "done"
  | "error";

/** Events a host consumer can subscribe to. */
export interface SessionEvents {
  /** Fired when the host screen changes. */
  screen: (screen: SessionScreen) => void;
  /** Fired when a game ends, with its result. */
  result: (result: GameResult) => void;
  /** Fired when recording state changes. */
  recording: (state: RecordingState, detail?: string) => void;
}

/** Re-export the concrete surface for host-internal wiring. */
export type { CanvasSurface } from "./canvas";
