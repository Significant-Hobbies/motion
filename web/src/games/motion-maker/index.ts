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

/** Openness at/below which an ARMED hand grabs (a clear fist). */
const GRAB_THRESHOLD = 0.4;
/** Openness at/above which a held hand releases (a clear open). */
const RELEASE_THRESHOLD = 0.6;
/**
 * Openness at/above which a hand becomes "armed" (clearly open). A grab requires an
 * armed hand to then close, so grabbing always needs a deliberate open→close swing —
 * a noisy value hovering near one threshold can never trigger an accidental grab.
 */
const OPEN_ARM_THRESHOLD = 0.6;
/**
 * Normalized (x-relative) reach: a hand this close to an object can grab it.
 * Generous so grabbing is forgiving at body distance where the pose is jittery.
 */
const GRAB_RADIUS = 0.15;
/** Object radius (normalized, x-relative). */
const OBJ_RADIUS = 0.055;
/** Target-bin half-width / half-height (normalized). */
const BIN_W = 0.16;
const BIN_H = 0.13;

// ── Sword ─────────────────────────────────────────────────────────────────────
// A sword is a special holdable object. It's grabbed with the same open→close
// gesture as a ball, but when held it renders as a blade pointing along your
// forearm (elbow→hand) and SLICES any free ball the blade sweeps through while
// you swing — turning "pick things up" into "wield a weapon".

/** Blade length beyond the hand (normalized, x-relative). */
const SWORD_LEN = 0.3;
/** Min hand speed (normalized/sec) for the moving blade to cut a ball. */
const SLICE_SPEED = 1.0;
/** How close (normalized) a ball's center must come to the blade line to be sliced. */
const SLICE_RADIUS = OBJ_RADIUS + 0.03;
/** Points for slicing a ball with the sword. */
const SLICE_SCORE = 150;
/** Number of free balls kept in play (the sword is extra, on top of these). */
const BALL_COUNT = 4;

/** Gentle upward-biased drift so free objects feel floaty, not heavy. */
const GRAVITY = 0.018; // per second^2, normalized-y (down = +)
const DRIFT = 0.006; // ambient horizontal wander
const DAMPING = 0.4; // per-second velocity damping while free
const WALL_BOUNCE = 0.6;

const COLORS = ["#5b8cff", "#35e0c8", "#ffb020", "#ff6b9d", "#b25cff"];

type Which = "left" | "right";

type Kind = "ball" | "sword";

interface FloatObj {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  /** "ball" (grab + drop in bin) or "sword" (held weapon that slices balls). */
  kind: Kind;
  /** Which hand holds it, or null if free. */
  heldBy: Which | null;
  /** Pop animation when scored (0..1), then respawn. */
  scoreAnim: number;
  /**
   * Blade tip in normalized coords (sword only). Recomputed from the forearm each
   * frame while held; kept at a resting angle while free so it renders lying down.
   */
  tipX: number;
  tipY: number;
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
  /** True once the hand has been clearly OPEN — arms the next grab. Consumed on grab. */
  armed: boolean;
}

function newHand(): HandTrack {
  return { x: 0.5, y: 0.5, vx: 0, vy: 0, prevOpen: 1, holding: null, armed: false };
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
  private sliced = 0;
  private binFlash = 0;
  /** Brief white flash along a blade right after it slices something (0..1). */
  private slashFlash: Record<Which, number> = { left: 0, right: 0 };

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
    this.sliced = 0;
    this.binFlash = 0;
    this.slashFlash = { left: 0, right: 0 };
    this.lastBody = null;
    this.spawnInitial();
  }

  private spawnInitial(): void {
    for (let i = 0; i < BALL_COUNT; i++) this.spawnObject();
    this.spawnSword();
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
      kind: "ball",
      heldBy: null,
      scoreAnim: 0,
      tipX: x,
      tipY: y,
    });
  }

  /** The single sword. Starts to one side, resting, waiting to be grabbed. */
  private spawnSword(): void {
    const x = 0.16;
    const y = 0.6;
    this.objects.push({
      id: this.nextId++,
      x,
      y,
      vx: 0,
      vy: 0,
      color: "#dfe6ff",
      kind: "sword",
      heldBy: null,
      scoreAnim: 0,
      // Resting blade points up-and-slightly-out so it reads as a sword on the ground.
      tipX: x + SWORD_LEN * 0.4,
      tipY: y - SWORD_LEN,
    });
  }

  isOver(): boolean {
    return false; // live mirror — never ends
  }

  result(): GameResult {
    return {
      score: this.score,
      stats: [
        { label: "dropped in bin", value: String(this.dropped) },
        { label: "sliced", value: String(this.sliced) },
      ],
    };
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dtMs: number, body: BodyController): void {
    this.lastBody = body;
    const dt = dtMs / 1000;
    this.binFlash = Math.max(0, this.binFlash - dt);
    this.slashFlash.left = Math.max(0, this.slashFlash.left - dt * 3);
    this.slashFlash.right = Math.max(0, this.slashFlash.right - dt * 3);

    this.trackHands(dt, body);
    this.resolveGrabs("left", body.leftHandOpen);
    this.resolveGrabs("right", body.rightHandOpen);
    this.integrateObjects(dt);
  }

  /**
   * Update smoothed hand positions + velocity used for grabbing. Uses the tracked
   * HAND joint (reliable, and where the on-screen hand is drawn) as the grab point.
   * (The precise fingertip is still streamed for future features like air-writing,
   * but it's too jittery at body distance to drive grab or a cursor.)
   */
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

  /**
   * Grab + release for one hand, driven ONLY by a deliberate OPEN→CLOSE gesture —
   * no hover/proximity grab (that grabbed things unintentionally). Hysteresis: the
   * hand must first be clearly OPEN (which "arms" a grab), then go clearly CLOSED
   * over a free object to grab it; the arm is consumed on grab so you must re-open
   * to grab again. A noisy openness value wobbling near one threshold can't trigger
   * a grab because it has to swing across the whole open→closed range.
   */
  private resolveGrabs(which: Which, open: number): void {
    const h = this.hands[which];

    // Arm once the hand is clearly OPEN.
    if (open > OPEN_ARM_THRESHOLD) h.armed = true;

    // Release: opened past the release threshold while holding (then must re-arm).
    if (h.holding !== null && open > RELEASE_THRESHOLD) {
      this.releaseHeld(h);
      h.armed = false;
    }

    // Grab: an ARMED hand that goes clearly CLOSED over a free object in reach.
    if (h.holding === null && h.armed && open < GRAB_THRESHOLD) {
      const target = this.nearestGrabbable(h.x, h.y);
      if (target) {
        target.heldBy = which;
        h.holding = target.id;
      }
      h.armed = false; // consume the arm — re-open to grab again
    }

    h.prevOpen = open;
  }

  /** Release the object a hand holds, imparting the hand's recent velocity. */
  private releaseHeld(h: HandTrack): void {
    const obj = this.objects.find((o) => o.id === h.holding);
    if (obj) {
      obj.heldBy = null;
      obj.vx = h.vx;
      obj.vy = h.vy;
    }
    h.holding = null;
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
        // Follow the holding hand exactly.
        const h = this.hands[o.heldBy];
        o.x = h.x;
        o.y = h.y;
        o.vx = h.vx;
        o.vy = h.vy;
        // A held sword also tracks the forearm so the blade points where you aim.
        if (o.kind === "sword") this.updateSwordBlade(o, o.heldBy);
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

      // A free sword drifts too, but keep its blade lying along its motion so it
      // never renders as a bare point; it's never scored in the bin.
      if (o.kind === "sword") {
        o.tipX = o.x + SWORD_LEN * 0.4;
        o.tipY = o.y - SWORD_LEN;
        continue;
      }

      // Balls score if they land inside the bin while free.
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

    this.sliceWithSwords();

    // Remove fully-popped BALLS and top up so there's always something to play.
    // The sword is never removed (scoreAnim stays 0), so it persists across slices.
    this.objects = this.objects.filter((o) => o.scoreAnim < 1);
    const balls = this.objects.filter((o) => o.kind === "ball").length;
    for (let i = balls; i < BALL_COUNT; i++) this.spawnObject();
  }

  /**
   * Point the held sword's blade along the forearm (elbow→hand) so it swings with
   * your arm. Falls back to the hand's recent velocity direction, then to straight
   * up, when the elbow isn't tracked. Writes the blade tip in normalized coords.
   */
  private updateSwordBlade(o: FloatObj, which: Which): void {
    const h = this.hands[which];
    const elbow =
      which === "left"
        ? this.lastBody?.joints.leftElbow
        : this.lastBody?.joints.rightElbow;

    let dx = 0;
    let dy = -1; // default: point up
    if (elbow) {
      dx = h.x - elbow[0];
      dy = h.y - elbow[1];
    } else if (Math.hypot(h.vx, h.vy) > 0.15) {
      dx = h.vx;
      dy = h.vy;
    }
    const len = Math.hypot(dx, dy) || 1;
    o.tipX = h.x + (dx / len) * SWORD_LEN;
    o.tipY = h.y + (dy / len) * SWORD_LEN;
  }

  /**
   * For each held, fast-moving sword, slice every free ball whose center passes
   * within SLICE_RADIUS of the blade segment (hand → tip). A still sword doesn't
   * cut — you must swing it — so balls can rest on the blade without popping.
   */
  private sliceWithSwords(): void {
    for (const sword of this.objects) {
      if (sword.kind !== "sword" || sword.heldBy === null) continue;
      const h = this.hands[sword.heldBy];
      if (Math.hypot(h.vx, h.vy) < SLICE_SPEED) continue;

      for (const ball of this.objects) {
        if (ball.kind !== "ball" || ball.heldBy !== null || ball.scoreAnim > 0)
          continue;
        const d = distPointToSegment(
          ball.x,
          ball.y,
          h.x,
          h.y,
          sword.tipX,
          sword.tipY,
        );
        if (d < SLICE_RADIUS) {
          ball.scoreAnim = 0.001; // start pop
          this.score += SLICE_SCORE;
          this.sliced++;
          this.slashFlash[sword.heldBy] = 1;
        }
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  render(r: Renderer): void {
    this.renderBin(r);
    this.renderObjects(r);
    this.renderAvatar(r);
    // Swords last so a held blade sits cleanly on top of the hand/arm.
    this.renderSwords(r);
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
      if (o.kind === "sword") continue; // drawn by renderSwords()
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
   * Draw every sword as a blade: a wooden handle + gold crossguard at the grip
   * (the hand, when held) and a steel blade running out to the tracked tip. A
   * brief blue glow flashes down the blade right after it slices something.
   */
  private renderSwords(r: Renderer): void {
    const { ctx } = r;
    for (const o of this.objects) {
      if (o.kind !== "sword" || o.scoreAnim > 0) continue;

      const [gx, gy] = this.pt(r, [o.x, o.y]); // grip (hand when held)
      const [tx, ty] = this.pt(r, [o.tipX, o.tipY]); // blade tip
      const len = Math.hypot(tx - gx, ty - gy) || 1;
      const ux = (tx - gx) / len; // unit vector along the blade
      const uy = (ty - gy) / len;
      const px = -uy; // perpendicular (crossguard axis)
      const py = ux;
      const held = o.heldBy !== null;
      const flash = held ? this.slashFlash[o.heldBy as Which] : 0;

      const handleLen = r.sx(0.05);
      const guardHalf = r.sx(0.035);
      const bladeW = Math.max(5, r.sx(0.014));

      ctx.save();
      ctx.lineCap = "round";

      // Handle behind the grip + a gold pommel.
      ctx.strokeStyle = "#6b4a2b";
      ctx.lineWidth = Math.max(6, r.sx(0.018));
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx - ux * handleLen, gy - uy * handleLen);
      ctx.stroke();
      ctx.fillStyle = "#d9a441";
      ctx.beginPath();
      ctx.arc(
        gx - ux * handleLen,
        gy - uy * handleLen,
        Math.max(4, r.sx(0.012)),
        0,
        Math.PI * 2,
      );
      ctx.fill();

      // Gold crossguard, perpendicular at the grip.
      ctx.strokeStyle = "#d9a441";
      ctx.lineWidth = Math.max(5, r.sx(0.014));
      ctx.beginPath();
      ctx.moveTo(gx - px * guardHalf, gy - py * guardHalf);
      ctx.lineTo(gx + px * guardHalf, gy + py * guardHalf);
      ctx.stroke();

      // Slice glow.
      if (flash > 0) {
        ctx.strokeStyle = `rgba(120,200,255,${0.55 * flash})`;
        ctx.lineWidth = bladeW * 3;
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }

      // Steel blade + a brighter core.
      ctx.strokeStyle = "#b9c4de";
      ctx.lineWidth = bladeW;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.strokeStyle = held ? "#ffffff" : "#eef2ff";
      ctx.lineWidth = Math.max(2, bladeW * 0.4);
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(tx, ty);
      ctx.stroke();

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

    // Map through a clamped projection so the avatar renders across the WHOLE
    // frame — including hands dropped below the waist. A hand that briefly
    // leaves the tracked frame (y or x slightly outside 0..1) is pinned to the
    // nearest edge instead of vanishing off-canvas.
    const [headX, headY] = this.pt(r, j.head);
    const [torsoX, torsoY] = this.pt(r, j.torso);
    const [lhX, lhY] = this.pt(r, j.leftHand);
    const [rhX, rhY] = this.pt(r, j.rightHand);

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
      { elbow: j.leftElbow ? this.pt(r, j.leftElbow) : undefined, hand: [lhX, lhY] },
      { elbow: j.rightElbow ? this.pt(r, j.rightElbow) : undefined, hand: [rhX, rhY] },
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

  /**
   * Project a normalized joint into play-area pixels, clamped to the full frame
   * (a small margin outside 0..1 is allowed so joints at the very edge still sit
   * on-screen). Ensures the whole avatar — head, torso, arms, and both hands —
   * renders anywhere in the frame, including low/below-the-waist hand positions,
   * without ever disappearing off-canvas.
   */
  private pt(r: Renderer, p: readonly [number, number]): [number, number] {
    const nx = p[0] < 0 ? 0 : p[0] > 1 ? 1 : p[0];
    const ny = p[1] < 0 ? 0 : p[1] > 1 ? 1 : p[1];
    return r.toPx(nx, ny);
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
      "Grab a ball → drop it in the bin · grab the sword → swing to slice",
      p.x + r.sx(0.03),
      p.y + r.sy(0.1),
    );
    ctx.restore();
  }
}

/** Shortest distance from point (px,py) to the segment (ax,ay)–(bx,by). */
function distPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
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
