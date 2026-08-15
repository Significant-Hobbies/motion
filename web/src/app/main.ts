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
  CAMERA,
} from "../config";
import { createSession, type Game } from "../sdk";
import { ReachDodge } from "../games/reach-dodge";
import { MotionMaker } from "../games/motion-maker";
import { Slice } from "../games/slice";
import { Overlay } from "./overlay";

const canvasEl = document.getElementById("game-canvas") as HTMLCanvasElement;
const overlayEl = document.getElementById("overlay") as HTMLElement;

const overlay = new Overlay(overlayEl);

// Game selection. `Slice` (Fruit-Ninja-style arcade) is the FEATURED game: it runs
// everywhere the phone (bridge) hosts the app, on the `?room=MOTION` live mirror, and
// via `?game=slice`. The older playground/round stay reachable by explicit `?game=`:
//   ?game=motion-maker → the interactive grab playground
//   ?game=reach-dodge  → the classic timed round
// The plain browser socket default (no param) keeps Reach & Dodge.
const gameParam = new URLSearchParams(location.search).get("game");

function pickGame(): { game: Game; live: boolean } {
  switch (gameParam) {
    case "motion-maker":
      return { game: new MotionMaker(), live: true };
    case "reach-dodge":
      return { game: new ReachDodge(), live: false };
    case "slice":
      return { game: new Slice(), live: true };
    default:
      // Featured everywhere the phone hosts it or the MOTION mirror is on.
      if (MOTION_MAKER || TRANSPORT === "bridge")
        return { game: new Slice(), live: true };
      return { game: new ReachDodge(), live: false };
  }
}

// `live` games are live/interactive and skip the mirror + readiness ceremony (the
// phone's own Start button is the readiness gate); classic rounds keep the gate.
const { game, live: skipReadinessForGame } = pickGame();

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
    // Drive from this device's webcam (browser MediaPipe) instead of the phone.
    camera: CAMERA,
    // Live/interactive games skip the mirror + readiness ceremony; camera mode always
    // does (it advances the moment the webcam first sees a hand).
    skipReadiness: skipReadinessForGame || CAMERA,
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
    ? "⬇ Download gameplay clip (WebM — MP4 needed for device compositing)"
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
