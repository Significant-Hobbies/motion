# Motion — Project Status

## Why / What

Use your body as a game controller. An iPhone or iPad runs Apple Vision 2D body-pose
detection on the front camera and drives a game with your movement. **v1 is a
serverless, single-device POC**: the game renders full-screen on the device and you
screen-mirror the device to a TV (AirPlay / Chromecast / QuickTime). No backend, no
accounts, no pairing.

The central product risk is **control feel**, not infrastructure — so v1 removes
every server and network hop. The browser display, relay, Chromecast receiver, and
multiplayer are **v2**, already scaffolded and parked in-repo.

## Dependencies

- **iOS 17+**, Xcode 16+, a physical iPhone or iPad (camera). Apple **Vision** + **AVFoundation**
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

- **2026-08-23** — Cut over to the `ios-landings` factory for real and removed
  the `site/` fork. Both this repo and the factory targeted Cloudflare Pages
  project `motion`, so whichever pushed last won. The factory now owns it: its
  build was deployed to `motion.significanthobbies.com` and the live HTML is
  byte-identical to `ios-landings/dist/motion/index.html`. The fork's better
  `llms.txt` — the real best-fit/not-a-fit lines and the CLI block — was ported
  into `ios-landings/products/motion/site.config.ts` first via new optional
  `agentFit`/`agentCli` config, so nothing regressed; the live `llms.txt` is
  byte-identical to what the fork served. `pnpm run deploy` here still fails on
  purpose.
- **2026-08-22** — Removed the superseded static `landing/` tree.
- **2026-08-17** — Public landing cut over to the ios-landings factory on
  the existing Cloudflare Pages project `motion`.
- **2026-08-12** — Adopted the Fleet code-health standard across TypeScript and
  Swift: added focused protocol/controller/readiness tests, honest full-source
  coverage, unused-code and cycle checks, complexity/duplication/dependency/
  suppression/hygiene ratchets, and an unsigned iOS build plus Swift quality CI.
  Existing measured debt remains explicit in GitHub issue #26.
- **2026-08-12** — Aligned the universal iPhone/iPad build, permission prompts,
  setup guidance, recording states, bundled web game, and App Store copy around
  device-neutral language; refreshed the personal-team distribution export.
- **2026-08-11** — Prepared the iPhone/iPad beta for TestFlight transport with
  versioned App Store metadata, a privacy manifest and public privacy surface,
  clean simulator screenshot evidence, an archive-safe bundled web-game sync,
  and a personal-team signed archive. App Store Connect record creation and
  physical camera/ReplayKit verification remain separate manual gates.
- **2026-08-09** — Pinned the landing release tool in the workspace lockfile
  and switched the deploy script to `pnpm exec`, removing npm/pnpm configuration
  deprecation warnings from the manual Cloudflare Pages release path.
- **2026-08-09** — Adopted the shared Ultracite lint baseline for the TypeScript
  relay and web-game surfaces. Thirty-nine applicable source and configuration
  files pass with zero diagnostics via explicit compatibility rules; iOS,
  built webgame bundles, public output, and runtime behavior remain unchanged.
- **2026-08-09** — Added repository-owned push/PR CI for the server/web
  typecheck, web build, and static landing contract, plus an explicit manual
  Cloudflare Pages release command for the live public landing. Hosted CI keeps
  iOS signing and physical-camera verification out of scope.
- **2026-07-31** — Extended the existing product-specific agent catalog with a
  full brief and changelog Markdown mirror while preserving the prototype and
  privacy boundaries; production deployment remains separate.
- **2026-07-30** — Made the canonical GitHub repository publicly readable and
  added its Roadmap and Source links to the owned changelog. This changes
  source visibility only; it does not deploy the internal app or grant a
  project-wide software license.
- **2026-07-30** — Added and locally verified the owned `/changelog` source:
  a newest-first public release trail using only confirmed milestones.
  Production deployment remains a separate manual step.
- **2026-07-29** — Released the public Motion product landing at
  [motion.significanthobbies.com](https://motion.significanthobbies.com) on
  Cloudflare Pages. The release includes agent-readable discovery surfaces and
  deliberately excludes the internal game, camera, and room routes.
- **2026-07-19** — Added privacy-safe Foundry evidence automation: `scripts/foundry-evidence.sh` generates `foundry-evidence.json` distinguishing source/build, simulator, signing, physical-device, and deployment states (no camera frames, motion samples, or device identifiers). Added `foundry-evidence.yml` CI workflow (macOS runner, uploads 30-day artifact). The internal iOS/game application is recorded as **intentionally undeployed** with signing + device blockers. See `docs/foundry-evidence.md`.
- **2026-07-18** — Repo created under fleet root. Built browser-first MVP (relay +
  browser + iOS), then **pivoted to the v1 serverless single-device POC** per product
  direction: phone renders the game (reusing the web game in a `WKWebView` via an
  in-process pose bridge) and screen-mirrors to a TV; recording via ReplayKit. Relay
  + browser display + camera-composite recording parked for v2. Remote target:
  [`Significant-Hobbies/motion`](https://github.com/Significant-Hobbies/motion).

## Products

- **Motion v1 POC** — one iPhone or iPad, on-device game (*Motion Maker*, the grab/toss
  playground the bridge transport runs), mirror to a TV.
- **Public product landing** — a static introduction for people interested in
  games, live at
  [motion.significanthobbies.com](https://motion.significanthobbies.com).
- **Public source** —
  [`Significant-Hobbies/motion`](https://github.com/Significant-Hobbies/motion),
  with open work tracked in
  [GitHub Issues](https://github.com/Significant-Hobbies/motion/issues).

## Features (shipped)

- **iOS beta preparation** — App Store identity/copy, Apple-accepted iPhone and
  iPad simulator screenshots, privacy metadata and support links, stable
  version/build settings, a clean default game canvas, and reproducible bundled
  web assets are ready for the existing manual TestFlight boundary.
- **Public landing** — responsive static product story with the existing Motion
  logo, canonical/share metadata, `llms.txt`, `index.md`, `/api/ai`, and an
  owned `/changelog` source with semantic dates and internal discovery.
  Security headers prohibit camera, microphone, and geolocation access; internal
  `/play`, `/camera`, and `/room` routes return 404.
- **`protocol/`** — v1 wire/bridge message shapes (pose packet, tracking, calib);
  recording-transfer messages retained for the v2 relay path.
- **`web/` — reusable game SDK.** Game-agnostic `sdk/` (room, `BodyController`,
  calibration, readiness, diagnostics, canvas, recording) + a `Game` interface; a game
  is a drop-in (`createSession({ game })`). Two games ship: **Motion Maker**
  (grab/toss playground; run whenever the transport is `bridge` — i.e. the device
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
- Shared Ultracite lint baseline with a clean TypeScript check.
- **Code-health gate** — `pnpm check` enforces the cross-platform TypeScript
  quality baseline; hosted macOS CI also builds the CocoaPods workspace and
  prevents Swift format or unused-code debt from increasing. Full TypeScript
  coverage is measured rather than scoped to tested modules, and all temporary
  baseline debt is owned by GitHub issue #26.
- **Self-contained app** — the web build is bundled into the app
  (`ios/Resources/webgame`, refreshed by `scripts/sync-webgame.sh`); `GameConfig`
  auto-prefers it, so the app runs on an iOS device with **no dev server / Mac network**.
  Verified: `webgame/` ships in the built `.app` and the app launches clean.

## Work queue

Open work is tracked only in [GitHub Issues](https://github.com/Significant-Hobbies/motion/issues).
An open issue is a to-do, a linked pull request is in progress, and merge plus
issue closure makes the work done.
