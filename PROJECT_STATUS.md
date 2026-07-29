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

## Work queue

Open work is tracked only in [GitHub Issues](https://github.com/sarthakagrawal927/motion/issues).
An open issue is a to-do, a linked pull request is in progress, and merge plus
issue closure makes the work done.
