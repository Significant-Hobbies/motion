// Host app entrypoint. Wires the Motion SDK to a concrete game (Reach &
// Dodge) and the DOM overlay. All platform behavior — room, controllers,
// readiness/calibration, the fixed-timestep loop, tracking-loss pause/resume,
// results, and recording — lives in the SDK. This file only:
//   - resolves runtime config,
//   - picks the game,
//   - mounts canvas + overlay,
//   - calls createSession().
//
// A new game is a drop-in: swap the `game:` argument. The app uses ONLY
// `../sdk` + `../games/*`.

import {
  PARTY_HOST,
  DEBUG,
  RECORD,
  FORCED_ROOM,
  TRANSPORT,
  MOTION_MAKER,
} from "../config";
import { createSession, type Game } from "../sdk";
import { ReachDodge } from "../games/reach-dodge";
import { MotionMaker } from "../games/motion-maker";
import { Overlay } from "./overlay";

const canvasEl = document.getElementById("game-canvas") as HTMLCanvasElement;
const overlayEl = document.getElementById("overlay") as HTMLElement;

const overlay = new Overlay(overlayEl);

// `?room=MOTION` (or `?game=motion-maker`) runs the interactive Motion Maker
// playground as a live mirror; everything else keeps the classic Reach & Dodge.
const game: Game = MOTION_MAKER ? new MotionMaker() : new ReachDodge();

const session = createSession({
  game,
  mount: { canvas: canvasEl, overlay: overlayEl },
  screens: overlay,
  options: {
    partyHost: PARTY_HOST,
    ...(FORCED_ROOM ? { forcedRoom: FORCED_ROOM } : {}),
    debug: DEBUG,
    record: RECORD,
    transport: TRANSPORT,
    // Motion Maker is a live interactive mirror — skip the readiness ceremony.
    skipReadiness: MOTION_MAKER,
  },
});

// Surface the last recorded clip for browser-side download (debug/no-phone):
// a floating link appears once a clip is ready and no phone consumed it.
session.on("recording", (phase) => {
  if (phase === "done" && session.lastClipUrl) {
    showDownloadLink(session.lastClipUrl, session.recorderNeedsMp4Warning);
  }
});

function showDownloadLink(url: string, webmWarning: boolean): void {
  const existing = document.getElementById("clip-download");
  existing?.remove();
  const a = document.createElement("a");
  a.id = "clip-download";
  a.href = url;
  a.download = webmWarning ? "motion-clip.webm" : "motion-clip.mp4";
  a.textContent = webmWarning
    ? "⬇ Download gameplay clip (WebM — MP4 needed for phone compositing)"
    : "⬇ Download gameplay clip";
  Object.assign(a.style, {
    position: "absolute",
    bottom: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "10px 16px",
    background: "rgba(53,224,200,0.14)",
    border: "1px solid rgba(53,224,200,0.5)",
    borderRadius: "10px",
    color: "#9ff5e6",
    font: "14px system-ui",
    textDecoration: "none",
    zIndex: "60",
    pointerEvents: "auto",
  } as CSSStyleDeclaration);
  overlayEl.appendChild(a);
}

// Expose for quick console debugging.
(window as unknown as { motion: unknown }).motion = {
  session,
  get controller() {
    return session.controller;
  },
};
