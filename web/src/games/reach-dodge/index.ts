// Reach & Dodge — a Motion game, implemented against the SDK `Game` contract.
//
// - Large targets spawn on the left or right edge; the matching hand hits them
//   for points. Targets time out.
// - Horizontal obstacle bars scroll in from the right at one of three lanes
//   (high / mid / low). The player avoids the obstacle by:
//     * leaning away (torso x) for high/mid bars, or
//     * squatting under a bar in the "duck" lane.
//   Getting clipped costs combo + a small time penalty flash.
// - ~75s session, mild difficulty ramp, clear score + combo.
//
// Everything reads from the BodyController abstraction and draws through the
// Renderer. The game is framework-free and driven by a fixed-timestep update;
// the host owns networking, readiness, pausing, results, and recording.

import type {
  BodyController,
  Game,
  GameContext,
  GameResult,
  Renderer,
} from "../../sdk";

const SESSION_MS = 75_000; // ~75s
const TARGET_RADIUS = 0.075; // normalized (x-relative)
const HIT_RADIUS = 0.11; // generous hitbox for readability/feel

type Side = "left" | "right";
type Lane = "high" | "mid" | "duck";

interface Target {
  id: number;
  side: Side;
  x: number;
  y: number;
  bornAt: number;
  ttl: number;
  hit: boolean;
  hitAnim: number; // 0..1 pop animation
}

interface Obstacle {
  id: number;
  lane: Lane;
  x: number; // normalized, moves right→left
  w: number;
  speed: number;
  scored: boolean;
  clipped: boolean;
}

const LANE_Y: Record<Lane, number> = { high: 0.32, mid: 0.5, duck: 0.72 };

export class ReachDodge implements Game {
  readonly id = "reach-dodge";
  readonly name = "Reach & Dodge";
  readonly durationMs = SESSION_MS;

  private elapsed = 0;
  private nextId = 1;
  private targets: Target[] = [];
  private obstacles: Obstacle[] = [];
  private spawnTargetIn = 0.8;
  private spawnObstacleIn = 2.2;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private dodges = 0;
  private clipFlash = 0; // seconds remaining on red flash
  private hitFlash = 0;

  /** Last input, stashed in update() so render() can draw the avatar. */
  private lastBody: BodyController | null = null;

  init(_ctx: GameContext): void {
    // Game state is normalized/resolution-independent; nothing to size here.
  }

  reset(): void {
    this.elapsed = 0;
    this.nextId = 1;
    this.targets = [];
    this.obstacles = [];
    this.spawnTargetIn = 0.8;
    this.spawnObstacleIn = 2.2;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.hits = 0;
    this.dodges = 0;
    this.clipFlash = 0;
    this.hitFlash = 0;
    this.lastBody = null;
  }

  private get remainingMs(): number {
    return Math.max(0, SESSION_MS - this.elapsed * 1000);
  }
  isOver(): boolean {
    return this.elapsed * 1000 >= SESSION_MS;
  }
  private get difficulty(): number {
    // 0..1 across the session.
    return Math.min(1, (this.elapsed * 1000) / SESSION_MS);
  }

  result(): GameResult {
    return {
      score: this.score,
      stats: [
        { label: "hits", value: String(this.hits) },
        { label: "dodges", value: String(this.dodges) },
        { label: "best combo", value: `x${this.bestCombo}` },
      ],
    };
  }

  /** Fixed-timestep update. `dtMs` is milliseconds (host contract). */
  update(dtMs: number, body: BodyController): void {
    this.lastBody = body;
    if (this.isOver()) return;
    const dt = dtMs / 1000;
    this.elapsed += dt;
    this.clipFlash = Math.max(0, this.clipFlash - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    const diff = this.difficulty;

    // ── Spawn targets ──
    this.spawnTargetIn -= dt;
    if (this.spawnTargetIn <= 0) {
      this.spawnTarget();
      this.spawnTargetIn = lerp(1.5, 0.7, diff) + Math.random() * 0.5;
    }

    // ── Spawn obstacles ──
    this.spawnObstacleIn -= dt;
    if (this.spawnObstacleIn <= 0) {
      this.spawnObstacle(diff);
      this.spawnObstacleIn = lerp(2.6, 1.2, diff) + Math.random() * 0.6;
    }

    this.updateTargets(dt, body);
    this.updateObstacles(dt, body);
  }

  private spawnTarget(): void {
    const side: Side = Math.random() < 0.5 ? "left" : "right";
    const x = side === "left" ? 0.16 : 0.84;
    const y = 0.28 + Math.random() * 0.4;
    this.targets.push({
      id: this.nextId++,
      side,
      x,
      y,
      bornAt: this.elapsed,
      ttl: 2.6,
      hit: false,
      hitAnim: 0,
    });
  }

  private spawnObstacle(diff: number): void {
    const lanes: Lane[] = ["high", "mid", "duck"];
    const lane = lanes[Math.floor(Math.random() * lanes.length)] as Lane;
    this.obstacles.push({
      id: this.nextId++,
      lane,
      x: 1.15,
      w: 0.14,
      speed: lerp(0.28, 0.5, diff),
      scored: false,
      clipped: false,
    });
  }

  private updateTargets(dt: number, body: BodyController): void {
    const lh = body.joints.leftHand;
    const rh = body.joints.rightHand;
    for (const t of this.targets) {
      if (t.hit) {
        t.hitAnim = Math.min(1, t.hitAnim + dt * 4);
        continue;
      }
      t.ttl -= dt;
      const hand = t.side === "left" ? lh : rh;
      const d = dist(hand[0], hand[1], t.x, t.y);
      if (d < HIT_RADIUS) {
        t.hit = true;
        this.hits++;
        this.combo++;
        this.bestCombo = Math.max(this.bestCombo, this.combo);
        this.score += 100 + this.combo * 10;
        this.hitFlash = 0.18;
      } else if (t.ttl <= 0) {
        // Missed target breaks combo.
        this.combo = 0;
      }
    }
    this.targets = this.targets.filter(
      (t) => (!t.hit && t.ttl > 0) || (t.hit && t.hitAnim < 1),
    );
  }

  private updateObstacles(dt: number, body: BodyController): void {
    const torsoX = body.joints.torso[0];
    const squat = body.squatAmount;
    for (const o of this.obstacles) {
      o.x -= o.speed * dt;

      // Score/collision resolves as the obstacle passes the player plane (~x 0.5).
      if (!o.scored && o.x <= 0.5) {
        o.scored = true;
        const dodged = this.isDodged(o.lane, torsoX, squat);
        if (dodged) {
          this.dodges++;
          this.combo++;
          this.bestCombo = Math.max(this.bestCombo, this.combo);
          this.score += 75 + this.combo * 5;
        } else {
          o.clipped = true;
          this.combo = 0;
          this.clipFlash = 0.4;
        }
      }
    }
    this.obstacles = this.obstacles.filter((o) => o.x > -0.25);
  }

  private isDodged(lane: Lane, torsoX: number, squat: number): boolean {
    if (lane === "duck") return squat > 0.45;
    // high / mid obstacles occupy one side; lean away to dodge.
    // Model: a bar covers the center; leaning past a threshold clears it.
    return Math.abs(torsoX - 0.5) > 0.16;
  }

  // ── Render ──
  render(r: Renderer): void {
    const { ctx } = r;
    const p = r.area;

    // Player plane guide.
    const [planeX] = r.toPx(0.5, 0);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(planeX, p.y);
    ctx.lineTo(planeX, p.y + p.h);
    ctx.stroke();
    ctx.restore();

    this.renderObstacles(r);
    this.renderTargets(r);

    if (this.lastBody) {
      r.drawSkeleton(this.lastBody, {
        color: this.clipFlash > 0 ? "#ff4d6d" : "#f4f7ff",
        handColor: this.hitFlash > 0 ? "#ffffff" : "#35e0c8",
      });
    }

    this.renderHud(r);

    if (this.clipFlash > 0) {
      ctx.save();
      ctx.fillStyle = `rgba(255,77,109,${0.25 * (this.clipFlash / 0.4)})`;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.restore();
    }
  }

  private renderTargets(r: Renderer): void {
    const { ctx } = r;
    for (const t of this.targets) {
      const [cx, cy] = r.toPx(t.x, t.y);
      const radius = r.sx(TARGET_RADIUS) * (1 + t.hitAnim * 0.8);
      const alpha = t.hit ? 1 - t.hitAnim : Math.min(1, t.ttl / 0.6);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = t.side === "left" ? "#5b8cff" : "#ffb020";
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 4;
      ctx.stroke();
      // Label the hand.
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#05070d";
      ctx.font = `bold ${Math.round(r.sx(0.045))}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t.side === "left" ? "L" : "R", cx, cy);
      ctx.restore();
    }
  }

  private renderObstacles(r: Renderer): void {
    const { ctx } = r;
    for (const o of this.obstacles) {
      const y = LANE_Y[o.lane];
      const [x0, cy] = r.toPx(o.x, y);
      const w = r.sx(o.w);
      const h = r.sy(o.lane === "duck" ? 0.1 : 0.14);
      ctx.save();
      ctx.fillStyle = o.clipped
        ? "#7a1f2c"
        : o.lane === "duck"
          ? "#b25cff"
          : "#ff5a72";
      roundRect(ctx, x0 - w / 2, cy - h / 2, w, h, 10);
      ctx.fill();
      // Hint arrow: duck = down, else = lean.
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = `bold ${Math.round(r.sx(0.04))}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(o.lane === "duck" ? "DUCK" : "LEAN", x0, cy);
      ctx.restore();
    }
  }

  private renderHud(r: Renderer): void {
    const { ctx } = r;
    const p = r.area;
    ctx.save();
    ctx.textBaseline = "top";

    // Score
    ctx.fillStyle = "#f4f7ff";
    ctx.font = `bold ${Math.round(r.sx(0.05))}px system-ui`;
    ctx.textAlign = "left";
    ctx.fillText(
      String(this.score).padStart(5, "0"),
      p.x + r.sx(0.03),
      p.y + r.sy(0.03),
    );

    // Combo
    if (this.combo > 1) {
      ctx.fillStyle = "#35e0c8";
      ctx.font = `bold ${Math.round(r.sx(0.035))}px system-ui`;
      ctx.fillText(`x${this.combo}`, p.x + r.sx(0.03), p.y + r.sy(0.1));
    }

    // Timer bar
    const frac = this.remainingMs / SESSION_MS;
    const barW = r.sx(0.3);
    const bx = p.x + p.w - barW - r.sx(0.03);
    const by = p.y + r.sy(0.04);
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    roundRect(ctx, bx, by, barW, r.sy(0.02), 6);
    ctx.fill();
    ctx.fillStyle = frac > 0.25 ? "#35e0c8" : "#ffcc33";
    roundRect(ctx, bx, by, barW * frac, r.sy(0.02), 6);
    ctx.fill();

    ctx.restore();
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
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
