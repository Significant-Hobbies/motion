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
- **PartyKit** (`server/`) — the v2 relay transport; also the endpoint the live
  `streamToWebsite` browser-mirror preview connects to today.
- A TV/monitor that accepts screen mirroring (any AirPlay/Chromecast target, or a Mac
  via QuickTime).

## Timeline

- **2026-07-19** — Added privacy-safe Foundry evidence automation: `scripts/foundry-evidence.sh` generates `foundry-evidence.json` distinguishing source/build, simulator, signing, physical-device, and deployment states (no camera frames, motion samples, or device identifiers). Added `foundry-evidence.yml` CI workflow (macOS runner, uploads 30-day artifact). Motion is recorded as **intentionally undeployed** with signing + device blockers. See `docs/foundry-evidence.md`.
- **2026-07-18** — Repo created under fleet root. Built browser-first MVP (relay +
  browser + iOS), then **pivoted to the v1 serverless single-device POC** per product
  direction: phone renders the game (reusing the web game in a `WKWebView` via an
  in-process pose bridge) and screen-mirrors to a TV; recording via ReplayKit. Relay
  + browser display + camera-composite recording parked for v2. Remote target:
  **personal GitHub** (not the fleet org).

## Products

- **Motion v1 POC** — one iPhone, on-phone game (*Motion Maker*, the grab/toss
  playground the bridge transport runs), mirror to a TV.

## Features (shipped)

- **`protocol/`** — v1 wire/bridge message shapes (pose packet, tracking, calib);
  recording-transfer messages retained for the v2 relay path.
- **`web/` — reusable game SDK.** Game-agnostic `sdk/` (room, `BodyController`,
  calibration, readiness, diagnostics, canvas, recording) + a `Game` interface; a game
  is a drop-in (`createSession({ game })`). Two games ship: **Motion Maker**
  (grab/toss playground; run whenever the transport is `bridge` — i.e. the phone
  hosts it — or via `?game=motion-maker` / `?room=MOTION`) and **Reach & Dodge**
  (timed round; the plain-browser socket default). Two transports: **`bridge`**
  (v1, in-process, native pushes pose via `window.__motion`) and **`socket`** (v2,
  PartyKit). Keyboard/mouse debug controller (`?debug=1`) for phone-free
  playtesting. **Typecheck + build green.**
- **`ios/` — the v1 app.** Front-camera capture → Vision pose → mirror-corrected,
  smoothed, normalized `Joints`; setup guidance + readiness; 5s calibration; a
  full-screen `WKWebView` game host fed pose over the JS bridge at ≤30 Hz; ReplayKit
  screen recording (game + camera inset → one video → Photos). On-device only.
- **Live "stream to website" path** — `AppModel.streamToWebsite` (a UI toggle)
  opens a `RoomSocket` to the PartyKit relay and streams every pose (with hands)
  to `ws://<devServerIP>:1999/parties/main/<roomCode>`, so a browser display
  mirrors the phone's motion live. Runs independently of and in addition to the
  local WKWebView game (streams straight from `setup`, not gated on full-body
  `.ok`). A working preview of the v2 relay path, wired today; the local game
  does not depend on it.
- **`server/`** — PartyKit relay. The v2 browser/multiplayer transport (kept
  typecheck-green); also the endpoint the live `streamToWebsite` preview connects
  to today.
- **Self-contained app** — the web build is bundled into the app
  (`ios/Resources/webgame`, refreshed by `scripts/sync-webgame.sh`); `GameConfig`
  auto-prefers it, so the app runs on a phone with **no dev server / Mac network**.
  Verified: `webgame/` ships in the built `.app` and the app launches clean.

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
- **Foundry evidence automation shipped (2026-07-19):** `scripts/foundry-evidence.sh`
  + `foundry-evidence.yml` CI workflow generate privacy-safe build/simulator/
  signing/device/deploy evidence. Signing + device blockers recorded honestly;
  deploy state is `intentionally_undeployed`. See `docs/foundry-evidence.md`.
- Run on a physical iPhone (plug in device, set signing team) and clear the
  device-only verify list. The Simulator build already passes.
- Playtest **control feel** with the keyboard-debug controller and on-device; tune
  smoothing / grab-reach / release thresholds until grabbing and tossing objects in
  Motion Maker feels good (and, for Reach & Dodge, target size / obstacle speed).
- ~~Bundle `web/dist` into the app for a self-contained "pure app"~~ — done.
- ~~Create the personal GitHub repo and push~~ — done (github.com/sarthakagrawal927/motion, private).

### Deferred → v2
- PartyKit relay + rooms; browser display; **Chromecast Cast-receiver** (low-latency,
  pose-only) and AirPlay second-screen; 1–4 player multiplayer + lobby; camera+gameplay
  composite recording over the relay; accounts/profiles; extra games (Reach Rush,
  Dodge Lane, Knee Beats, Pose Party).
