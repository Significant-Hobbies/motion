// Draws a body skeleton from a BodyController into the canvas play area.
// Shared by the mirror test screen and the in-game avatar so what the player
// calibrates against is exactly what they play with.

import type { CanvasSurface } from "./canvas";
import type { BodyController } from "./controller";
import type { Joints } from "../../../protocol/protocol";

// Leg + spine bones are always straight lines. The arms are drawn separately so
// that, when the optional shoulder/elbow joints are present, we can draw a real
// bent shoulder→elbow→hand chain instead of a straight torso→hand line.
const BONES: [keyof Joints, keyof Joints][] = [
  ["head", "torso"],
  ["torso", "leftKnee"],
  ["torso", "rightKnee"],
  ["leftKnee", "leftFoot"],
  ["rightKnee", "rightFoot"],
];

type Side = { shoulder: keyof Joints; elbow: keyof Joints; hand: keyof Joints };
const ARM_SIDES: Side[] = [
  { shoulder: "leftShoulder", elbow: "leftElbow", hand: "leftHand" },
  { shoulder: "rightShoulder", elbow: "rightElbow", hand: "rightHand" },
];

export function drawSkeleton(
  surf: CanvasSurface,
  body: BodyController,
  opts: { color?: string; handColor?: string; alpha?: number } = {}
): void {
  const { ctx } = surf;
  const j = body.joints;
  const color = opts.color ?? "#f4f7ff";
  const handColor = opts.handColor ?? "#35e0c8";
  const alpha = opts.alpha ?? 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(3, surf.sx(0.012));
  ctx.lineCap = "round";
  ctx.strokeStyle = color;

  for (const [a, b] of BONES) {
    const pa = j[a];
    const pb = j[b];
    if (!pa || !pb) continue;
    const [ax, ay] = surf.toPx(pa[0], pa[1]);
    const [bx, by] = surf.toPx(pb[0], pb[1]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // Arms. When the real shoulder+elbow joints are present, draw the bent chain
  // shoulder→elbow→hand; otherwise fall back to a straight torso→hand line.
  for (const { shoulder, elbow, hand } of ARM_SIDES) {
    drawArm(ctx, surf, j, shoulder, elbow, hand);
  }

  // Head
  const [hx, hy] = surf.toPx(j.head[0], j.head[1]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(hx, hy, Math.max(8, surf.sx(0.028)), 0, Math.PI * 2);
  ctx.fill();

  // Hands — the interactive points, highlighted.
  for (const hand of [j.leftHand, j.rightHand] as const) {
    const [x, y] = surf.toPx(hand[0], hand[1]);
    ctx.fillStyle = handColor;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(10, surf.sx(0.03)), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(x, y, Math.max(4, surf.sx(0.012)), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/** Draw one arm as a shoulder→elbow→hand chain, or a straight torso→hand fallback. */
function drawArm(
  ctx: CanvasRenderingContext2D,
  surf: CanvasSurface,
  j: BodyController["joints"],
  shoulder: keyof Joints,
  elbow: keyof Joints,
  hand: keyof Joints
): void {
  const sh = j[shoulder];
  const el = j[elbow];
  const hd = j[hand] as [number, number];
  ctx.beginPath();
  if (sh && el) {
    const [sx, sy] = surf.toPx(sh[0], sh[1]);
    const [ex, ey] = surf.toPx(el[0], el[1]);
    const [hx, hy] = surf.toPx(hd[0], hd[1]);
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.lineTo(hx, hy);
  } else {
    const from = sh ?? j.torso;
    const [fx, fy] = surf.toPx(from[0], from[1]);
    const [hx, hy] = surf.toPx(hd[0], hd[1]);
    ctx.moveTo(fx, fy);
    ctx.lineTo(hx, hy);
  }
  ctx.stroke();
}
