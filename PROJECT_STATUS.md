# Motion — Project Status

## Why / What

Use your body as a game controller. An iPhone runs Apple Vision 2D body-pose
detection on the front camera and drives a game with your movement. **v1 is a
serverless, single-device POC**: the game renders full-screen on the phone and you
screen-mirror the phone to a TV (AirPlay / Chromecast / QuickTime). No backend, no
accounts, no pairing.

The central product risk is **control feel**, not infrastructure — so v1 removes
every server and network hop. The browser display, relay, Chromecast receiver, and
multiplayer are **v2**, already scaffolded and parked in-repo.

## Dependencies

- **iOS 17+**, Xcode 16+, a physical iPhone (camera). Apple **Vision** + **AVFoundation**
  (on-device pose, no ML model), **WebKit** (`WKWebView` game host), **ReplayKit**
  (screen recording), **Photos** (save).
- **XcodeGen** — generates the Xcode project from `ios/project.yml`.
- **Node ≥20 / npm** + **Vite + TypeScript** — the game (`web/`), served to the phone
  WebView from the Vite dev server (or bundled for a pure app).
- **PartyKit** (`server/`) — parked; the v2 relay transport.
- A TV/monitor that accepts screen mirroring (any AirPlay/Chromecast target, or a Mac
  via QuickTime).

## Timeline

- **2026-07-18** — Repo created under fleet root. Built browser-first MVP (relay +
  browser + iOS), then **pivoted to the v1 serverless single-device POC** per product
  direction: phone renders the game (reusing the web game in a `WKWebView` via an
  in-process pose bridge) and screen-mirrors to a TV; recording via ReplayKit. Relay
  + browser display + camera-composite recording parked for v2. Remote target:
  **personal GitHub** (not the fleet org).

## Products

- **Motion v1 POC** — one iPhone, one game (*Reach & Dodge*), mirror to a TV.

## Features (shipped)

- **`protocol/`** — v1 wire/bridge message shapes (pose packet, tracking, calib);
  recording-transfer messages retained for the v2 relay path.
- **`web/` — reusable game SDK.** Game-agnostic `sdk/` (room, `BodyController`,
  calibration, readiness, diagnostics, canvas, recording) + a `Game` interface; a game
  is a drop-in (`createSession({ game })`). *Reach & Dodge* is the first consumer.
  Two transports: **`bridge`** (v1, in-process, native pushes pose via
  `window.__motion`) and **`socket`** (v2, PartyKit). Keyboard/mouse debug
  controller (`?debug=1`) for phone-free playtesting. **Typecheck + build green.**
- **`ios/` — the v1 app.** Front-camera capture → Vision pose → mirror-corrected,
  smoothed, normalized `Joints`; setup guidance + readiness; 5s calibration; a
  full-screen `WKWebView` game host fed pose over the JS bridge at ≤30 Hz; ReplayKit
  screen recording (game + camera inset → one video → Photos). On-device only.
- **`server/`** — PartyKit relay, **parked for v2**; kept typecheck-green.

## Todo / Planned / Deferred / Blocked

### iOS build — VERIFIED COMPILES (2026-07-18)
- The iOS app **compiles cleanly for the iOS 27 Simulator** (Xcode 27, `xcodegen
  generate` + `xcodebuild`, `CODE_SIGNING_ALLOWED=NO`). Two compiler-caught bugs
  fixed: a `private(set)` `ready` write in `GameWebView`, and a Swift-6 illegal
  `NSLock.lock()` in an async context in the parked `CameraRecorder`.
- Remaining: warnings only — non-`Sendable` `CMSampleBuffer`/`AVAssetWriter` captures
  in `@Sendable` closures, and iOS-27 `AVAssetWriter` API deprecations (still valid on
  iOS 17+). Non-blocking; tidy later.

### Blocked / must-verify on a physical device (Simulator has no camera)
- **ReplayKit captures the `WKWebView` game content** (out-of-process render) — the
  single biggest unknown; if the canvas records blank, fall back to a bundled
  `file://` load or a native-rendered camera-inset+HUD (TODO in `ScreenRecorder.swift`).
- ReplayKit captures the `AVCaptureVideoPreviewLayer` camera inset (not black).
- Vision **left/right joint mapping** matches the real player (front-camera mirror).
- Camera + Photos-add permission prompts; the http LAN dev-server load + local-network
  prompt.

### Todo (next)
- Run on a physical iPhone (plug in device, set signing team) and clear the
  device-only verify list. The Simulator build already passes.
- Playtest **control feel** with the keyboard-debug controller and on-device; tune
  smoothing / target size / obstacle speed until a 90s round is fun.
- Bundle `web/dist` into the app for a self-contained "pure app" (no dev server).
- Create the personal GitHub repo and push.

### Deferred → v2
- PartyKit relay + rooms; browser display; **Chromecast Cast-receiver** (low-latency,
  pose-only) and AirPlay second-screen; 1–4 player multiplayer + lobby; camera+gameplay
  composite recording over the relay; accounts/profiles; extra games (Reach Rush,
  Dodge Lane, Knee Beats, Pose Party).
