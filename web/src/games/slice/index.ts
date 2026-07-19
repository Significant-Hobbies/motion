// Slice — a Fruit Ninja–style body game. Fruit is tossed up in arcs; BOTH of the
// player's hands are blades that leave a trail and slice any fruit a fast swipe
// passes through. Slice several in one swing for a combo multiplier. Bombs cost a
// life; letting fruit fall costs a life. Three lives, escalating waves, then a
// score screen + Play Again.
//
// Reads input ONLY through the BodyController abstraction (the two hand joints) and
// draws through the Renderer. Upper-body only — head/torso/hands, never legs — so it
// works standing back from a TV with just the upper body in frame.

import type {
  BodyController,
  Game,
  GameContext,
  GameResult,
  Renderer,
} from "../../sdk";

// ── Tuning ──────────────────────────────────────────────────────────────────────

const START_LIVES = 3;
/** Hand speed (normalized/sec) above which the hand's swipe slices fruit. */
const SLICE_SPEED = 0.8;
/** How close (normalized) a fruit center must come to the swipe line to be sliced. */
const SLICE_REACH = 0.09;
/** Two slices within this window chain into a combo. */
const COMBO_WINDOW_S = 0.45;
/** Gravity on airborne fruit (normalized-y/sec², down = +). */
const GRAVITY = 0.9;
/** Trail length (recent hand points) drawn as the blade. */
const TRAIL_LEN = 10;

const FRUIT_COLORS = ["#ff5b6a", "#ffb020", "#35e0c8", "#5b8cff", "#b25cff", "#ff8f3f"];

type Which = "left" | "right";

interface Fruit {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  bomb: boolean;
  /** Counted as missed already (so a fruit only costs one life). */
  counted: boolean;
}

interface Half {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  ang: number;
  va: number;
  side: number; // -1 / +1, which half
  life: number; // 1 → 0
}

interface Splat {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  life: number;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
}

interface HandTrack {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Smoothed blade-aim unit vector: the swing direction (falls back to resting). */
  aimx: number;
  aimy: number;
  trail: { x: number; y: number }[];
}

function newHand(restAimX: number): HandTrack {
  // Rest pointing up-and-outward (left blade tilts left, right blade tilts right).
  const len = Math.hypot(restAimX, -1) || 1;
  return { x: 0.5, y: 0.5, vx: 0, vy: 0, aimx: restAimX / len, aimy: -1 / len, trail: [] };
}

export class Slice implements Game {
  readonly id = "slice";
  readonly name = "Slice";
  readonly durationMs = Number.POSITIVE_INFINITY; // ends on lives out (isOver)

  private nextId = 1;
  private fruits: Fruit[] = [];
  private halves: Half[] = [];
  private splats: Splat[] = [];
  private popups: Popup[] = [];
  private hands: Record<Which, HandTrack> = { left: newHand(-0.5), right: newHand(0.5) };

  private score = 0;
  private lives = START_LIVES;
  private sliced = 0;
  private bestCombo = 0;

  private elapsed = 0; // seconds, for difficulty ramp
  private spawnTimer = 0;
  /** Slices in the current combo window + when the last slice happened. */
  private comboCount = 0;
  private lastSliceAt = -999;
  private hitFlash = 0; // white/red flash intensity (0..1)
  private flashColor = "255,90,106";
  private shake = 0;

  init(_ctx: GameContext): void {
    this.reset();
  }

  reset(): void {
    this.nextId = 1;
    this.fruits = [];
    this.halves = [];
    this.splats = [];
    this.popups = [];
    this.hands = { left: newHand(-0.5), right: newHand(0.5) };
    this.score = 0;
    this.lives = START_LIVES;
    this.sliced = 0;
    this.bestCombo = 0;
    this.elapsed = 0;
    this.spawnTimer = 0.6; // brief beat before the first toss
    this.comboCount = 0;
    this.lastSliceAt = -999;
    this.hitFlash = 0;
    this.shake = 0;
  }

  isOver(): boolean {
    return this.lives <= 0;
  }

  result(): GameResult {
    return {
      score: this.score,
      stats: [
        { label: "sliced", value: String(this.sliced) },
        { label: "best combo", value: `${this.bestCombo}×` },
      ],
    };
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  update(dtMs: number, body: BodyController): void {
    const dt = Math.min(0.05, dtMs / 1000);
    this.elapsed += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2);
    this.shake = Math.max(0, this.shake - dt * 3);

    this.trackHands(dt, body);
    this.spawn(dt);
    this.integrate(dt);
    this.slice();
    this.expireCombo();
  }

  private trackHands(dt: number, body: BodyController): void {
    const map: Record<Which, readonly [number, number]> = {
      left: body.joints.leftHand,
      right: body.joints.rightHand,
    };
    for (const which of ["left", "right"] as const) {
      const h = this.hands[which];
      const [nx, ny] = map[which];
      if (dt > 0) {
        h.vx = (nx - h.x) / dt;
        h.vy = (ny - h.y) / dt;
      }
      h.x = nx;
      h.y = ny;
      // Point the blade along the swing when moving; hold the last aim when nearly
      // still (so a resting blade doesn't spin from jitter). Smoothed for a steady look.
      const speed = Math.hypot(h.vx, h.vy);
      if (speed > 0.25) {
        const ax = h.vx / speed;
        const ay = h.vy / speed;
        h.aimx += (ax - h.aimx) * 0.35;
        h.aimy += (ay - h.aimy) * 0.35;
        const al = Math.hypot(h.aimx, h.aimy) || 1;
        h.aimx /= al;
        h.aimy /= al;
      }
      h.trail.push({ x: nx, y: ny });
      if (h.trail.length > TRAIL_LEN) h.trail.shift();
    }
  }

  /** Difficulty ramps with elapsed time: faster spawns, more per wave, more bombs. */
  private spawn(dt: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;

    // Spawn interval shrinks from ~1.15s toward ~0.5s over the first ~90s.
    const ramp = Math.min(1, this.elapsed / 90);
    this.spawnTimer = 1.15 - 0.65 * ramp + Math.random() * 0.25;

    // 1–3 fruit per wave (more as it ramps).
    const count = 1 + Math.floor(Math.random() * (1 + Math.round(ramp * 2)));
    for (let i = 0; i < count; i++) this.launch(false);

    // Bomb chance climbs from ~8% to ~22%.
    if (Math.random() < 0.08 + ramp * 0.14) this.launch(true);
  }

  /** Toss one fruit/bomb up from the bottom in a reachable arc. */
  private launch(bomb: boolean): void {
    const x = 0.14 + Math.random() * 0.72;
    // Aim the arc apex into the chest/reach band; nudge horizontal toward center.
    const vy = -(1.0 + Math.random() * 0.28);
    const vx = (0.5 - x) * 0.35 + (Math.random() - 0.5) * 0.12;
    this.fruits.push({
      id: this.nextId++,
      x,
      y: 1.08,
      vx,
      vy,
      r: bomb ? 0.055 : 0.05 + Math.random() * 0.02,
      color: bomb ? "#20242e" : (FRUIT_COLORS[this.nextId % FRUIT_COLORS.length] ?? "#ff5b6a"),
      bomb,
      counted: false,
    });
  }

  private integrate(dt: number): void {
    for (const f of this.fruits) {
      f.vy += GRAVITY * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
    }
    // A real (non-bomb) fruit that falls off the bottom un-sliced costs a life.
    for (const f of this.fruits) {
      if (!f.counted && f.y - f.r > 1.12 && f.vy > 0) {
        f.counted = true;
        if (!f.bomb) this.loseLife("120,140,180");
      }
    }
    this.fruits = this.fruits.filter((f) => f.y - f.r <= 1.15);

    // Halves + splatter + popups age out.
    for (const h of this.halves) {
      h.vy += GRAVITY * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.ang += h.va * dt;
      h.life -= dt * 0.8;
    }
    this.halves = this.halves.filter((h) => h.life > 0);
    for (const s of this.splats) {
      s.vy += GRAVITY * 0.6 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt * 1.6;
    }
    this.splats = this.splats.filter((s) => s.life > 0);
    for (const p of this.popups) {
      p.y -= dt * 0.06;
      p.life -= dt * 1.2;
    }
    this.popups = this.popups.filter((p) => p.life > 0);
  }

  /** Each fast-moving hand slices any fruit its swipe segment crosses this frame. */
  private slice(): void {
    for (const which of ["left", "right"] as const) {
      const h = this.hands[which];
      const speed = Math.hypot(h.vx, h.vy);
      if (speed < SLICE_SPEED) continue;
      const trail = h.trail;
      if (trail.length < 2) continue;
      const a = trail[trail.length - 2];
      const b = trail[trail.length - 1];
      if (!a || !b) continue;

      for (const f of this.fruits) {
        if (f.counted) continue;
        if (distPointToSegment(f.x, f.y, a.x, a.y, b.x, b.y) < f.r + SLICE_REACH) {
          this.onSliced(f, b.x - a.x, b.y - a.y);
        }
      }
    }
  }

  private onSliced(f: Fruit, dirx: number, diry: number): void {
    f.counted = true;
    this.fruits = this.fruits.filter((x) => x.id !== f.id);

    if (f.bomb) {
      this.loseLife("255,70,70");
      this.shake = 1;
      this.spawnSplat(f.x, f.y, "255,120,60", 22);
      this.comboCount = 0;
      return;
    }

    this.sliced++;
    // Combo: slices chained within the window multiply the score.
    const now = this.elapsed;
    this.comboCount = now - this.lastSliceAt <= COMBO_WINDOW_S ? this.comboCount + 1 : 1;
    this.lastSliceAt = now;
    this.bestCombo = Math.max(this.bestCombo, this.comboCount);

    const base = 10;
    const gained = base * this.comboCount;
    this.score += gained;

    if (this.comboCount >= 2) {
      this.popups.push({
        x: f.x,
        y: f.y,
        text: `${this.comboCount}×  +${gained}`,
        color: "#ffd84d",
        life: 1,
      });
    }

    this.spawnHalves(f, dirx, diry);
    this.spawnSplat(f.x, f.y, hexToRgb(f.color), 12);
  }

  private spawnHalves(f: Fruit, dirx: number, diry: number): void {
    const len = Math.hypot(dirx, diry) || 1;
    // Perpendicular to the slice direction — the two halves fly apart along it.
    const px = -diry / len;
    const py = dirx / len;
    const kick = 0.25;
    for (const side of [-1, 1]) {
      this.halves.push({
        x: f.x,
        y: f.y,
        vx: f.vx + px * kick * side,
        vy: f.vy * 0.5 + py * kick * side,
        r: f.r,
        color: f.color,
        ang: Math.atan2(diry, dirx),
        va: side * (2 + Math.random() * 2),
        side,
        life: 1,
      });
    }
  }

  private spawnSplat(x: number, y: number, rgb: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.15 + Math.random() * 0.5;
      this.splats.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.1,
        r: 0.004 + Math.random() * 0.01,
        color: rgb,
        life: 1,
      });
    }
  }

  private loseLife(flashRgb: string): void {
    this.lives = Math.max(0, this.lives - 1);
    this.hitFlash = 1;
    this.flashColor = flashRgb;
  }

  private expireCombo(): void {
    if (this.elapsed - this.lastSliceAt > COMBO_WINDOW_S) this.comboCount = 0;
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  render(r: Renderer): void {
    const { ctx } = r;
    ctx.save();
    if (this.shake > 0) {
      const s = this.shake * r.sx(0.012);
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    this.renderSplats(r);
    this.renderFruits(r);
    this.renderHalves(r);
    this.renderBlades(r);
    this.renderPopups(r);

    ctx.restore();

    this.renderHud(r);
    this.renderFlash(r);
  }

  private renderFruits(r: Renderer): void {
    const { ctx } = r;
    for (const f of this.fruits) {
      const [cx, cy] = r.toPx(f.x, f.y);
      const rad = r.sx(f.r);
      if (f.bomb) {
        ctx.fillStyle = "#181b22";
        ctx.strokeStyle = "#ff5b5b";
        ctx.lineWidth = Math.max(2, r.sx(0.006));
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Fuse spark.
        ctx.fillStyle = "#ffcc33";
        ctx.beginPath();
        ctx.arc(cx + rad * 0.5, cy - rad * 0.8, rad * 0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ff5b5b";
        ctx.font = `bold ${Math.round(rad * 1.1)}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("!", cx, cy);
      } else {
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.beginPath();
        ctx.arc(cx - rad * 0.32, cy - rad * 0.32, rad * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private renderHalves(r: Renderer): void {
    const { ctx } = r;
    for (const h of this.halves) {
      const [cx, cy] = r.toPx(h.x, h.y);
      const rad = r.sx(h.r);
      ctx.save();
      ctx.globalAlpha = Math.max(0, h.life);
      ctx.translate(cx, cy);
      ctx.rotate(h.ang);
      ctx.fillStyle = h.color;
      ctx.beginPath();
      // A half disc (flat face along the slice).
      ctx.arc(0, 0, rad, h.side > 0 ? 0 : Math.PI, h.side > 0 ? Math.PI : Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      // Pale inner flesh along the cut.
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(-rad, -rad * 0.12, rad * 2, rad * 0.24);
      ctx.restore();
    }
  }

  private renderSplats(r: Renderer): void {
    const { ctx } = r;
    for (const s of this.splats) {
      const [cx, cy] = r.toPx(s.x, s.y);
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.fillStyle = `rgb(${s.color})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r.sx(s.r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Each hand is a katana-style blade pointing along the swing, with a motion trail. */
  private renderBlades(r: Renderer): void {
    const { ctx } = r;
    for (const which of ["left", "right"] as const) {
      const h = this.hands[which];

      // Motion trail behind the blade (brighter/thicker when swinging fast).
      const t = h.trail;
      if (t.length >= 2) {
        for (let i = 1; i < t.length; i++) {
          const p0 = t[i - 1];
          const p1 = t[i];
          if (!p0 || !p1) continue;
          const [x0, y0] = r.toPx(p0.x, p0.y);
          const [x1, y1] = r.toPx(p1.x, p1.y);
          const f = i / t.length; // older = thinner/fainter
          ctx.strokeStyle = `rgba(180,235,255,${0.05 + f * 0.4})`;
          ctx.lineWidth = Math.max(1, r.sx(0.004 + f * 0.02));
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }

      const fast = Math.hypot(h.vx, h.vy) > SLICE_SPEED;
      const bladeLen = fast ? 0.19 : 0.15;
      // Grip is BEHIND the hand so the blade extends past it along the aim; the hand
      // sits at the guard (where the collision/swipe point is).
      const [gx, gy] = r.toPx(h.x - h.aimx * 0.045, h.y - h.aimy * 0.045);
      const [hx, hy] = r.toPx(h.x, h.y); // guard / hand
      const [tx, ty] = r.toPx(h.x + h.aimx * bladeLen, h.y + h.aimy * bladeLen);
      const len = Math.hypot(tx - hx, ty - hy) || 1;
      const px = -(ty - hy) / len; // perpendicular for the guard
      const py = (tx - hx) / len;

      ctx.save();
      ctx.lineCap = "round";

      // Handle (grip → hand) + pommel.
      ctx.strokeStyle = "#6b4a2b";
      ctx.lineWidth = Math.max(5, r.sx(0.016));
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(hx, hy);
      ctx.stroke();

      // Guard.
      const guard = r.sx(0.028);
      ctx.strokeStyle = "#d9a441";
      ctx.lineWidth = Math.max(4, r.sx(0.012));
      ctx.beginPath();
      ctx.moveTo(hx - px * guard, hy - py * guard);
      ctx.lineTo(hx + px * guard, hy + py * guard);
      ctx.stroke();

      // Glow along the blade when swinging.
      const bladeW = Math.max(4, r.sx(0.013));
      if (fast) {
        ctx.strokeStyle = "rgba(150,215,255,0.55)";
        ctx.lineWidth = bladeW * 3;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }

      // Steel blade + bright core.
      ctx.strokeStyle = "#c3ccdf";
      ctx.lineWidth = bladeW;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.strokeStyle = fast ? "#ffffff" : "#eef3ff";
      ctx.lineWidth = Math.max(2, bladeW * 0.4);
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      ctx.restore();
    }
  }

  private renderPopups(r: Renderer): void {
    const { ctx } = r;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of this.popups) {
      const [cx, cy] = r.toPx(p.x, p.y);
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.font = `bold ${Math.round(r.sx(0.04))}px system-ui`;
      ctx.fillText(p.text, cx, cy);
    }
    ctx.globalAlpha = 1;
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

    // Lives as hearts, top-right.
    ctx.textAlign = "right";
    ctx.font = `${Math.round(r.sx(0.04))}px system-ui`;
    let hearts = "";
    for (let i = 0; i < START_LIVES; i++) hearts += i < this.lives ? "♥ " : "♡ ";
    ctx.fillStyle = "#ff6b7f";
    ctx.fillText(hearts.trim(), p.x + p.w - r.sx(0.03), p.y + r.sy(0.035));

    // Live combo banner.
    if (this.comboCount >= 2) {
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffd84d";
      ctx.font = `bold ${Math.round(r.sx(0.03))}px system-ui`;
      ctx.fillText(`${this.comboCount}× combo`, p.x + r.sx(0.03), p.y + r.sy(0.1));
    }
    ctx.restore();
  }

  private renderFlash(r: Renderer): void {
    if (this.hitFlash <= 0) return;
    const { ctx } = r;
    const p = r.area;
    ctx.save();
    ctx.fillStyle = `rgba(${this.flashColor},${this.hitFlash * 0.35})`;
    ctx.fillRect(p.x, p.y, p.w, p.h);
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

/** "#rrggbb" → "r,g,b" for rgba() splatter fills. */
function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "255,255,255";
  return `${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)}`;
}
