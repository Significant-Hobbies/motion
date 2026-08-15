// HTML overlay screens for text-heavy states (pairing, readiness checklist,
// tracking-lost banner, results). The canvas draws the live skeleton/game
// underneath; these render big, high-contrast, TV-legible panels on top.
//
// Everything is plain DOM (no framework). Each `render*` call fully rebuilds
// the overlay's inner HTML for the given state — cheap for these low-frequency
// screens and keeps the state machine dead simple. This is the app's
// implementation of the SDK's `SessionScreenRenderer` — the SDK stays free of
// copy/branding.

import type {
  GameResult,
  PairingCtx,
  ReadinessState,
  SessionScreenRenderer,
} from "../sdk";

export class Overlay implements SessionScreenRenderer {
  constructor(private root: HTMLElement) {}

  clear(): void {
    this.root.innerHTML = "";
  }

  private panel(inner: string): void {
    this.root.innerHTML = `<div style="${PANEL}">${inner}</div>`;
  }

  pairing(ctx: PairingCtx): void {
    const { code, conn, host, debug, recordOn, onToggleRecord } = ctx;
    const dot =
      conn === "open"
        ? "#35e0c8"
        : conn === "connecting"
          ? "#ffcc33"
          : "#ff4d6d";
    const connLabel =
      conn === "open"
        ? "connected to relay"
        : conn === "connecting"
          ? "connecting…"
          : "reconnecting…";
    this.panel(`
      <div style="${KICKER}">Motion</div>
      <div style="font-size:min(3.2vw,26px);color:#8a95b5;margin-bottom:18px">
        Open the Motion app on your iPhone or iPad and enter this code
      </div>
      <div style="${CODE_STYLE}">${spaced(code)}</div>
      <div style="display:flex;align-items:center;gap:10px;justify-content:center;margin-top:26px">
        <span style="width:14px;height:14px;border-radius:50%;background:${dot};box-shadow:0 0 12px ${dot}"></span>
        <span style="font-size:min(2.4vw,20px);color:#8a95b5">${connLabel}</span>
      </div>
      <label style="${REC_TOGGLE}">
        <input id="rec-toggle" type="checkbox" ${recordOn ? "checked" : ""} style="width:20px;height:20px;accent-color:#35e0c8" />
        <span>Record gameplay clip${debug ? " (browser download in debug)" : " → device"}</span>
      </label>
      <div style="font-size:12px;color:#4b5573;margin-top:16px">relay: ${escapeHtml(host)}</div>
      ${debug ? `<div style="${DEBUG_TAG}">DEBUG MODE — no iOS device needed. Move the mouse to begin.</div>` : ""}
    `);
    const toggle = this.root.querySelector<HTMLInputElement>("#rec-toggle");
    toggle?.addEventListener("change", () => onToggleRecord(!!toggle.checked));
  }

  readiness(state: ReadinessState, debug: boolean): void {
    const row = (ok: boolean, label: string, extra = "") =>
      `<div style="display:flex;align-items:center;gap:14px;font-size:min(3vw,24px);margin:10px 0">
         <span style="font-size:1.3em">${ok ? "✅" : "⬜"}</span>
         <span style="color:${ok ? "#f4f7ff" : "#8a95b5"}">${label}</span>
         <span style="color:#4b5573;font-size:0.8em">${extra}</span>
       </div>`;
    const pct = Math.round(state.qualityHold * 100);
    this.panel(`
      <div style="${KICKER}">Get ready</div>
      ${row(state.peer, debug ? "Debug controller active" : "iOS device connected")}
      ${row(state.joints, "Body in frame")}
      ${row(state.quality, "Tracking stable", state.quality ? "" : `holding ${pct}%`)}
      ${row(state.calibrated, debug ? "Calibration (auto)" : "Calibration complete")}
      <div style="margin-top:26px;font-size:min(2.4vw,20px);color:${state.ready ? "#35e0c8" : "#8a95b5"}">
        ${state.ready ? "Ready! Starting…" : "Complete the checklist to start"}
      </div>
    `);
  }

  mirror(): void {
    this.root.innerHTML = `
      <div style="position:absolute;top:6%;left:0;right:0;text-align:center;pointer-events:none">
        <div style="${KICKER}">Mirror test</div>
        <div style="font-size:min(2.6vw,22px);color:#8a95b5">
          Move around — confirm the avatar follows you. Auto-advancing when tracking is stable.
        </div>
      </div>`;
  }

  trackingLost(): void {
    this.panel(`
      <div style="font-size:min(6vw,54px);font-weight:800;color:#ff4d6d;margin-bottom:12px">Tracking lost</div>
      <div style="font-size:min(3vw,26px);color:#f4f7ff">Reposition so your whole body is in frame</div>
      <div style="font-size:min(2.2vw,18px);color:#8a95b5;margin-top:16px">Game paused — it resumes automatically</div>
    `);
  }

  reconnecting(): void {
    this.panel(`
      <div style="font-size:min(5vw,44px);font-weight:800;color:#ffcc33;margin-bottom:12px">Reconnecting…</div>
      <div style="font-size:min(2.4vw,20px);color:#8a95b5">Holding your room. This resumes on its own.</div>
    `);
  }

  results(r: GameResult, onPlayAgain: () => void): void {
    const stats = r.stats
      .map(
        (s) =>
          `<div><b style="color:#f4f7ff">${escapeHtml(s.value)}</b><br><span style="color:#8a95b5">${escapeHtml(s.label)}</span></div>`
      )
      .join("");
    this.panel(`
      <div style="${KICKER}">Time!</div>
      <div style="font-size:min(9vw,90px);font-weight:800;color:#35e0c8;line-height:1">${r.score}</div>
      <div style="font-size:min(2.6vw,22px);color:#8a95b5;margin:6px 0 22px">points</div>
      <div style="display:flex;gap:32px;justify-content:center;font-size:min(2.6vw,22px);margin-bottom:28px">
        ${stats}
      </div>
      <button id="play-again" style="${BUTTON}">Play again</button>
    `);
    const btn = this.root.querySelector<HTMLButtonElement>("#play-again");
    btn?.addEventListener("click", onPlayAgain);
  }
}

function spaced(code: string): string {
  return code.split("").join(" ");
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}

const PANEL =
  "text-align:center;background:rgba(9,13,24,0.92);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:min(6vw,56px) min(8vw,80px);box-shadow:0 20px 80px rgba(0,0,0,0.6);max-width:90vw";
const KICKER =
  "font-size:min(2.2vw,18px);letter-spacing:0.3em;text-transform:uppercase;color:#35e0c8;margin-bottom:14px";
const CODE_STYLE =
  "font-size:min(16vw,150px);font-weight:800;letter-spacing:0.08em;color:#f4f7ff;font-variant-numeric:tabular-nums;text-shadow:0 0 40px rgba(53,224,200,0.25)";
const DEBUG_TAG =
  "margin-top:22px;font-size:min(2vw,16px);color:#ffcc33;border:1px dashed rgba(255,204,51,0.5);padding:8px 14px;border-radius:8px;display:inline-block";
const REC_TOGGLE =
  "display:inline-flex;align-items:center;gap:10px;margin-top:22px;font-size:min(2.2vw,18px);color:#8a95b5;cursor:pointer;user-select:none";
const BUTTON =
  "font-size:min(3vw,26px);font-weight:700;color:#05070d;background:#35e0c8;border:none;border-radius:12px;padding:14px 40px;cursor:pointer";
