// Draws a body skeleton from a BodyController into the canvas play area.
// Shared by the mirror test screen and the in-game avatar so what the player
// calibrates against is exactly what they play with.

import type { CanvasSurface } from "./canvas";
import type { BodyController } from "./controller";
import type { Joints } from "../../../protocol/protocol";

const BONES: [keyof Joints, keyof Joints][] = [
  ["head", "torso"],
  ["torso", "leftHand"],
  ["torso", "rightHand"],
  ["torso", "leftKnee"],
  ["torso", "rightKnee"],
  ["leftKnee", "leftFoot"],
  ["rightKnee", "rightFoot"],
];

export function drawSkeleton(
  surf: CanvasSurface,
  body: BodyController,
  opts: { color?: string; handColor?: string; alpha?: number } = {},
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
    const [ax, ay] = surf.toPx(j[a][0], j[a][1]);
    const [bx, by] = surf.toPx(j[b][0], j[b][1]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
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
