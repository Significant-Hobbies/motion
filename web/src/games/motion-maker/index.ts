// Motion Maker — an interactive body-controlled playground (a Game, but never a
// timed round). The player's live pose is drawn as a clean mirrored avatar; a
// handful of floating objects drift around the scene. Close a hand near an
// object to GRAB it, move it, and open the hand to RELEASE (tossing it with the
// hand's recent velocity). Drop objects into the target bin to score.
//
// Reads input ONLY through the BodyController abstraction (joints + the new
// leftHandOpen / rightHandOpen), and draws through the Renderer. Upper-body
// friendly: it uses head / torso / hands only — never legs, feet, or squat — so
// it works for someone seated at a desk showing their upper body.

import type {
  BodyController,
  Game,
  GameContext,
  GameResult,
  Renderer,
} from "../../sdk";

// ── Interaction tuning ────────────────────────────────────────────────────────

/** Openness at/below which a hand counts as CLOSED (a fist → grab). */
const GRAB_THRESHOLD = 0.4;
/** Openness at/above which a held hand counts as OPEN (→ release). */
const RELEASE_THRESHOLD = 0.6;
/** Normalized (x-relative) reach: a hand this close to an object can grab it. */
const GRAB_RADIUS = 0.11;
/** Object radius (normalized, x-relative). */
const OBJ_RADIUS = 0.055;
/** Target-bin half-width / half-height (normalized). */
const BIN_W = 0.16;
const BIN_H = 0.13;

/** Gentle upward-biased drift so free objects feel floaty, not heavy. */
const GRAVITY = 0.018; // per second^2, normalized-y (down = +)
const DRIFT = 0.006; // ambient horizontal wander
const DAMPING = 0.4; // per-second velocity damping while free
const WALL_BOUNCE = 0.6;

const COLORS = ["#5b8cff", "#35e0c8", "#ffb020", "#ff6b9d", "#b25cff"];

type Which = "left" | "right";

interface FloatObj {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  /** Which hand holds it, or null if free. */
  heldBy: Which | null;
  /** Pop animation when scored (0..1), then respawn. */
  scoreAnim: number;
}

/** Per-hand tracking of position history so we can impart toss velocity. */
interface HandTrack {
  x: number;
  y: number;
  /** Recent velocity (normalized/sec), smoothed. */
  vx: number;
  vy: number;
  /** Previous openness, to detect the open→closed transition edge. */
  prevOpen: number;
  /** Object id currently held, or null. */
  holding: number | null;
}

function newHand(): HandTrack {
  return { x: 0.5, y: 0.5, vx: 0, vy: 0, prevOpen: 1, holding: null };
}

export class MotionMaker implements Game {
  readonly id = "motion-maker";
  readonly name = "Motion Maker";
  // Effectively endless: the host treats isOver() as truth and we never end.
  readonly durationMs = Number.POSITIVE_INFINITY;

  private nextId = 1;
  private objects: FloatObj[] = [];
  private hands: Record<Which, HandTrack> = {
    left: newHand(),
    right: newHand(),
  };
  private score = 0;
  private dropped = 0;
  private binFlash = 0;

  /** Target bin, centered near the bottom-center of the play area. */
  private readonly bin = { x: 0.5, y: 0.82 };

  /** Last input, stashed in update() so render() can draw the avatar. */
  private lastBody: BodyController | null = null;

  init(_ctx: GameContext): void {
    if (this.objects.length === 0) this.spawnInitial();
  }

  reset(): void {
    this.nextId = 1;
    this.objects = [];
    this.hands = { left: newHand(), right: newHand() };
    this.score = 0;
    this.dropped = 0;
    this.binFlash = 0;
    this.lastBody = null;
    this.spawnInitial();
  }

  private spawnInitial(): void {
    for (let i = 0; i < 4; i++) this.spawnObject();
  }

  private spawnObject(): void {
    // Spawn in the upper reachable band so they float down into hand range.
    const x = 0.2 + Math.random() * 0.6;
    const y = 0.18 + Math.random() * 0.22;
    this.objects.push({
      id: this.nextId++,
      x,
      y,
      vx: (Math.random() - 0.5) * 0.05,
      vy: 0,
      color: COLORS[this.nextId % COLORS.length] ?? "#5b8cff",
      heldBy: null,
      scoreAnim: 0,
    });
  }

  isOver(): boolean {
    return false; // live mirror — never ends
  }

  result(): GameResult {
    return {
      score: this.score,
      stats: [{ label: "dropped in bin", value: String(this.dropped) }],
    };
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dtMs: number, body: BodyController): void {
    this.lastBody = body;
    const dt = dtMs / 1000;
    this.binFlash = Math.max(0, this.binFlash - dt);

    this.trackHands(dt, body);
    this.resolveGrabs("left", body.leftHandOpen);
    this.resolveGrabs("right", body.rightHandOpen);
    this.integrateObjects(dt);
  }

  /** Update smoothed hand positions + velocity from the body joints. */
  private trackHands(dt: number, body: BodyController): void {
    const map: Record<Which, readonly [number, number]> = {
      left: body.joints.leftHand,
      right: body.joints.rightHand,
    };
    for (const which of ["left", "right"] as const) {
      const h = this.hands[which];
      const [nx, ny] = map[which];
      if (dt > 0) {
        const ivx = (nx - h.x) / dt;
        const ivy = (ny - h.y) / dt;
        // Smooth the velocity so a toss uses recent motion, not a single frame.
        h.vx += (ivx - h.vx) * 0.5;
        h.vy += (ivy - h.vy) * 0.5;
      }
      h.x = nx;
      h.y = ny;
    }
  }

  /** Handle grab (open→closed near object) and release (opens) for one hand. */
  private resolveGrabs(which: Which, open: number): void {
    const h = this.hands[which];
    const wasClosed = h.prevOpen < GRAB_THRESHOLD;
    const isClosed = open < GRAB_THRESHOLD;

    // Release: the hand opened past the release threshold while holding.
    if (h.holding !== null && open > RELEASE_THRESHOLD) {
      const obj = this.objects.find((o) => o.id === h.holding);
      if (obj) {
        obj.heldBy = null;
        // Impart the hand's recent velocity so you can toss it.
        obj.vx = h.vx;
        obj.vy = h.vy;
      }
      h.holding = null;
    }

    // Grab: on the open→closed edge, snap the nearest free in-reach object.
    if (h.holding === null && isClosed && !wasClosed) {
      const target = this.nearestGrabbable(h.x, h.y);
      if (target) {
        target.heldBy = which;
        h.holding = target.id;
      }
    }

    h.prevOpen = open;
  }

  private nearestGrabbable(hx: number, hy: number): FloatObj | null {
    let best: FloatObj | null = null;
    let bestD = GRAB_RADIUS;
    for (const o of this.objects) {
      if (o.heldBy !== null || o.scoreAnim > 0) continue;
      const d = Math.hypot(o.x - hx, o.y - hy);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  private integrateObjects(dt: number): void {
    for (const o of this.objects) {
      if (o.scoreAnim > 0) {
        o.scoreAnim = Math.min(1, o.scoreAnim + dt * 3);
        continue;
      }

      if (o.heldBy !== null) {
        // Follow the holding hand exactly (with a slight offset above it).
        const h = this.hands[o.heldBy];
        o.x = h.x;
        o.y = h.y;
        o.vx = h.vx;
        o.vy = h.vy;
        continue;
      }

      // Free: floaty physics.
      o.vy += GRAVITY * dt;
      o.vx += (Math.random() - 0.5) * DRIFT * dt;
      o.vx -= o.vx * DAMPING * dt;
      o.vy -= o.vy * DAMPING * dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;

      // Bounce off the walls / floor so objects stay in play.
      if (o.x < OBJ_RADIUS) {
        o.x = OBJ_RADIUS;
        o.vx = Math.abs(o.vx) * WALL_BOUNCE;
      } else if (o.x > 1 - OBJ_RADIUS) {
        o.x = 1 - OBJ_RADIUS;
        o.vx = -Math.abs(o.vx) * WALL_BOUNCE;
      }
      if (o.y < OBJ_RADIUS) {
        o.y = OBJ_RADIUS;
        o.vy = Math.abs(o.vy) * WALL_BOUNCE;
      } else if (o.y > 1 - OBJ_RADIUS) {
        o.y = 1 - OBJ_RADIUS;
        o.vy = -Math.abs(o.vy) * WALL_BOUNCE;
      }

      // Scored if it lands inside the bin while free.
      if (
        Math.abs(o.x - this.bin.x) < BIN_W &&
        Math.abs(o.y - this.bin.y) < BIN_H
      ) {
        o.scoreAnim = 0.001; // start pop
        this.score += 100;
        this.dropped++;
        this.binFlash = 0.5;
      }
    }

    // Remove fully-popped objects and top up so there's always something to play.
    this.objects = this.objects.filter((o) => o.scoreAnim < 1);
    while (this.objects.length < 4) this.spawnObject();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  render(r: Renderer): void {
    this.renderBin(r);
    this.renderObjects(r);
    this.renderAvatar(r);
    this.renderHud(r);
  }

  private renderBin(r: Renderer): void {
    const { ctx } = r;
    const [cx, cy] = r.toPx(this.bin.x, this.bin.y);
    const w = r.sx(BIN_W * 2);
    const h = r.sy(BIN_H * 2);
    ctx.save();
    const glow = this.binFlash > 0 ? this.binFlash / 0.5 : 0;
    ctx.strokeStyle =
      glow > 0 ? `rgba(53,224,200,${0.6 + glow * 0.4})` : "rgba(53,224,200,0.45)";
    ctx.lineWidth = Math.max(3, r.sx(0.008));
    ctx.setLineDash([r.sx(0.02), r.sx(0.014)]);
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, r.sx(0.02));
    ctx.stroke();
    ctx.setLineDash([]);
    if (glow > 0) {
      ctx.fillStyle = `rgba(53,224,200,${0.12 * glow})`;
      ctx.fill();
    }
    ctx.fillStyle = "rgba(53,224,200,0.7)";
    ctx.font = `bold ${Math.round(r.sx(0.028))}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("DROP HERE", cx, cy);
    ctx.restore();
  }

  private renderObjects(r: Renderer): void {
    const { ctx } = r;
    for (const o of this.objects) {
      const [cx, cy] = r.toPx(o.x, o.y);
      const pop = o.scoreAnim > 0 ? 1 + o.scoreAnim * 0.8 : 1;
      const radius = r.sx(OBJ_RADIUS) * pop;
      const alpha = o.scoreAnim > 0 ? 1 - o.scoreAnim : 1;
      ctx.save();
      ctx.globalAlpha = alpha;
      // Held objects get a highlight ring.
      if (o.heldBy !== null) {
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = Math.max(3, r.sx(0.008));
        ctx.beginPath();
        ctx.arc(cx, cy, radius + r.sx(0.014), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = o.color;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(cx - radius * 0.3, cy - radius * 0.3, radius * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Draw a clean, mirrored upper-body avatar directly (not the shared skeleton):
   * head, torso, arms, and hands rendered open vs closed from the openness value.
   */
  private renderAvatar(r: Renderer): void {
    const body = this.lastBody;
    if (!body) return;
    const { ctx } = r;
    const j = body.joints;

    const [headX, headY] = r.toPx(j.head[0], j.head[1]);
    const [torsoX, torsoY] = r.toPx(j.torso[0], j.torso[1]);
    const [lhX, lhY] = r.toPx(j.leftHand[0], j.leftHand[1]);
    const [rhX, rhY] = r.toPx(j.rightHand[0], j.rightHand[1]);

    // Simple stick figure: both arms hang off ONE neck anchor on the spine (no
    // separate shoulders / shoulder line). ~42% down from the head toward the torso.
    const neckX = headX + (torsoX - headX) * 0.42;
    const neckY = headY + (torsoY - headY) * 0.42;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#f4f7ff";
    ctx.lineWidth = Math.max(6, r.sx(0.02));

    // Spine.
    ctx.beginPath();
    ctx.moveTo(headX, headY);
    ctx.lineTo(torsoX, torsoY);
    ctx.stroke();

    // Arms: neck → elbow (when tracked, for a real bend) → hand. Straight fallback.
    const arms: { elbow: [number, number] | undefined; hand: [number, number] }[] = [
      { elbow: j.leftElbow ? r.toPx(j.leftElbow[0], j.leftElbow[1]) : undefined, hand: [lhX, lhY] },
      { elbow: j.rightElbow ? r.toPx(j.rightElbow[0], j.rightElbow[1]) : undefined, hand: [rhX, rhY] },
    ];
    for (const { elbow, hand } of arms) {
      ctx.beginPath();
      ctx.moveTo(neckX, neckY);
      if (elbow) ctx.lineTo(elbow[0], elbow[1]);
      ctx.lineTo(hand[0], hand[1]);
      ctx.stroke();
    }

    // Head.
    ctx.fillStyle = "#f4f7ff";
    ctx.beginPath();
    ctx.arc(headX, headY, Math.max(10, r.sx(0.032)), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Hands — draw open vs closed.
    this.drawHand(r, lhX, lhY, body.leftHandOpen, this.hands.left.holding !== null);
    this.drawHand(
      r,
      rhX,
      rhY,
      body.rightHandOpen,
      this.hands.right.holding !== null,
    );
  }

  /** Open hand = a spread ring of fingers; closed hand = a filled fist. */
  private drawHand(
    r: Renderer,
    x: number,
    y: number,
    open: number,
    holding: boolean,
  ): void {
    const { ctx } = r;
    const base = Math.max(10, r.sx(0.03));
    ctx.save();
    const closed = open < GRAB_THRESHOLD;
    const color = holding ? "#ffffff" : closed ? "#ff6b9d" : "#35e0c8";

    if (closed) {
      // Fist: solid filled circle, slightly smaller.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, base * 0.85, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Open palm: a palm dot with fingers spreading out proportional to openness.
      const spread = base * (0.7 + open * 0.9);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(3, r.sx(0.009));
      ctx.lineCap = "round";
      const fingers = 5;
      for (let i = 0; i < fingers; i++) {
        const ang = -Math.PI / 2 + (i - (fingers - 1) / 2) * 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * spread, y + Math.sin(ang) * spread);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, base * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private renderHud(r: Renderer): void {
    const { ctx } = r;
    const p = r.area;
    ctx.save();
    ctx.textBaseline = "top";
    ctx.fillStyle = "#f4f7ff";
    ctx.font = `bold ${Math.round(r.sx(0.05))}px system-ui`;
    ctx.textAlign = "left";
    ctx.fillText(String(this.score).padStart(4, "0"), p.x + r.sx(0.03), p.y + r.sy(0.03));

    ctx.fillStyle = "#8a95b5";
    ctx.font = `${Math.round(r.sx(0.024))}px system-ui`;
    ctx.fillText(
      "Close a hand near an object to grab · open to drop it in the bin",
      p.x + r.sx(0.03),
      p.y + r.sy(0.1),
    );
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const rr = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
