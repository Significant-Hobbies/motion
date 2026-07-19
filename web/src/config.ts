// Runtime config resolved from URL query params + Vite env, with sane dev defaults.

import { hasNativeBridge } from "./sdk/bridge";

const params = new URLSearchParams(location.search);

/** Which input transport to use. */
export type Transport = "socket" | "bridge";

/**
 * Transport selection. Defaults to the in-process JS bridge (Motion's
 * serverless single-device v1) when we're running inside the WKWebView host
 * (`window.webkit.messageHandlers.motion` present) OR `?transport=bridge` is
 * set. Otherwise the socket relay (browser + multiplayer v2), so the plain
 * browser path is unchanged.
 */
export const TRANSPORT: Transport = (() => {
  const forced = params.get("transport");
  if (forced === "bridge" || forced === "socket") return forced;
  return hasNativeBridge() ? "bridge" : "socket";
})();

/** PartyKit host. `?server=` wins, then VITE_PARTY_HOST, then local dev default. */
export const PARTY_HOST: string =
  params.get("server") ??
  (import.meta.env.VITE_PARTY_HOST as string | undefined) ??
  "http://127.0.0.1:1999";

/** Debug mode: enables keyboard/mouse controller + diagnostics overlay. */
export const DEBUG: boolean = params.get("debug") === "1";

/**
 * Webcam mode (`?camera=1`): drive the game from THIS device's webcam via in-browser
 * MediaPipe hand tracking — no phone. Browser-only (the phone uses its native camera).
 * Overrides the socket/relay controller with `WebcamController`.
 */
export const CAMERA: boolean = params.get("camera") === "1";

/** Recording default: opt-in via `?record=1`. Also toggleable in the pairing UI. */
export const RECORD: boolean = params.get("record") === "1";

/** Optional forced room code (uppercased) for reconnecting to a known room. */
export const FORCED_ROOM: string | null = (() => {
  const r = params.get("room");
  return r ? r.toUpperCase() : null;
})();

/**
 * The interactive "motion maker" experience. Enabled when:
 *   - the forced room is `MOTION` (`?room=MOTION`) — the display becomes a live
 *     mirror the moment the phone connects, OR
 *   - `?game=motion-maker` is passed explicitly.
 * In this mode the app runs the Motion Maker playground and skips the
 * mirror-test + readiness ceremony (it's a live mirror, not a timed round).
 * Works with `?debug=1` too (mouse = a hand, click/space = close it).
 */
export const MOTION_MAKER: boolean =
  FORCED_ROOM === "MOTION" || params.get("game") === "motion-maker";
