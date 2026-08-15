// Debug diagnostics overlay (behind ?debug=1). Dense, monospace, fixed corner.
// Shows the numbers that matter for the #1 risk (control feel): RTT, pose rate,
// last seq, tracking quality, motion→render latency, and dropped/stale counts.

import type { Room } from "./room";
import type { BodyController } from "./controller";

export class Diagnostics {
  private el: HTMLDivElement;
  private frames = 0;
  private poseCount = 0;
  private lastPoseCountAt = performance.now();
  private poseRate = 0;
  private lastSeq = -1;
  private droppedSeq = 0;
  private staleCount = 0;
  private lastLatency = 0;

  constructor(
    parent: HTMLElement,
    private room: Room,
    private live: boolean
  ) {
    this.el = document.createElement("div");
    Object.assign(this.el.style, {
      position: "absolute",
      top: "12px",
      left: "12px",
      padding: "10px 12px",
      background: "rgba(5,7,13,0.82)",
      border: "1px solid rgba(53,224,200,0.4)",
      borderRadius: "8px",
      font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
      color: "#9ff5e6",
      whiteSpace: "pre",
      pointerEvents: "none",
      zIndex: "50",
    } as CSSStyleDeclaration);
    parent.appendChild(this.el);

    if (this.live) {
      this.room.on("pose", (p) => {
        this.poseCount++;
        if (this.lastSeq >= 0 && p.seq > this.lastSeq + 1) {
          this.droppedSeq += p.seq - this.lastSeq - 1;
        }
        this.lastSeq = p.seq;
        // Motion→render latency: now(display) vs sentAt(controller), skew-corrected.
        const nowController = performance.now() + this.room.clockSkew;
        this.lastLatency = Math.max(0, nowController - p.sentAt);
      });
    }
  }

  /** Called once per rendered frame. */
  update(body: BodyController): void {
    this.frames++;
    const now = performance.now();
    const dtS = (now - this.lastPoseCountAt) / 1000;
    if (dtS >= 0.5) {
      this.poseRate = this.poseCount / dtS;
      this.poseCount = 0;
      this.lastPoseCountAt = now;
    }
    if (body.health === "stale") this.staleCount++;

    const rtt = this.room.rtt < 0 ? "—" : this.room.rtt.toFixed(0);
    const lat = this.live ? `${this.lastLatency.toFixed(0)}ms` : "n/a (debug)";
    const rate = this.live ? `${this.poseRate.toFixed(1)}/s` : "n/a (debug)";
    const seq = this.live ? String(this.lastSeq) : "n/a";

    this.el.textContent = [
      `Motion diag   room ${this.room.code}`,
      `conn      ${this.room.connectionState}`,
      `peer      ${this.room.peerConnected ? "controller ✓" : "—"}`,
      `rtt       ${rtt} ms`,
      `pose rate ${rate}`,
      `last seq  ${seq}`,
      `dropped   ${this.droppedSeq}`,
      `stale hit ${this.staleCount}`,
      `m→render  ${lat}`,
      `quality   ${body.trackingQuality.toFixed(2)}  (${body.health})`,
      `squat     ${body.squatAmount.toFixed(2)}`,
      `lean      ${body.leanAmount.toFixed(2)}`,
    ].join("\n");
  }

  dispose(): void {
    this.el.remove();
  }
}
