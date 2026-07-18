# Motion — Decision Log

Short, dated record of the choices that shaped the build. One entry per decision:
the call, the alternatives, and why.

## 2026-07-18 — Browser-first, not AirPlay-only

**Call:** The display is a browser game, not an AirPlay screen mirror.
**Alternatives:** AirPlay-only would demo marginally faster.
**Why:** AirPlay-only forces building the real client/networking architecture
later anyway. Browser-first gives laptops, desktops, tablets, and laptop-to-TV on
day one, and the transport (phone→room→display) is the actual product spine.

## 2026-07-18 — Phone does the ML, not a cloud service or the browser

**Call:** Apple **Vision** (`VNDetectHumanBodyPoseRequest`) runs on the iPhone;
only 8 normalized joint points leave the device.
**Alternatives:** Stream video to a server for pose estimation; run a WASM/TF.js
pose model in the browser from a phone camera.
**Why:** No custom ML model needed (Vision ships body landmarks), latency stays
low (no video round-trip), and privacy is a feature — **camera frames never leave
the phone**. It also keeps bandwidth to a trickle (~20 tiny JSON packets/sec).

## 2026-07-18 — Dumb relay, display owns game state

**Call:** The server only relays pose packets and presence. The browser owns all
game logic and rendering; the phone sends input, never decisions.
**Alternatives:** Server-authoritative gameplay from the start.
**Why:** For single-player the display is the only authority that matters, and
server-authoritative gameplay is a large tax that buys nothing until multiplayer.
Deferring it keeps the MVP small and the latency budget honest.

## 2026-07-18 — PartyKit for transport, behind an abstraction

**Call:** PartyKit rooms for the WebSocket relay; the PartyKit room id **is** the
6-char code. Wrapped behind a small room abstraction on both clients.
**Alternatives:** Raw `ws` server; a bespoke Cloudflare Durable Object now.
**Why:** PartyKit gives rooms, hibernation, and presence for near-zero code, and
it is now part of Cloudflare — so a later move to a self-hosted Durable Object in
our own CF account is a transport swap, not a rearchitecture. Keeping it behind an
interface avoids a hard dependency on a proprietary game backend.

## 2026-07-18 — Keyboard/mouse debug controller is a first-class citizen

**Call:** The whole browser game is playable with a mouse+keyboard controller
(`?debug=1`), implementing the same `BodyController` interface as the phone.
**Alternatives:** Only testable with a real phone in the loop.
**Why:** The product's #1 risk is **control feel**. Being able to iterate on the
game — targets, obstacle speed, smoothing — without pairing a phone every time is
the single biggest lever on iteration speed. The phone becomes just another
implementation of the same input abstraction.

## 2026-07-18 — One game, then stop

**Call:** Ship exactly one game (*Reach & Dodge*) that exercises hands, head,
torso, knees, calibration, latency, and tracking loss.
**Alternatives:** Build the four-game catalogue from PRD-2 up front.
**Why:** One game validates the entire motion pipeline. More games before control
feel is proven is polishing a mechanism that might still need to change.

## 2026-07-18 — iOS delivered as source + XcodeGen, not a checked-in .xcodeproj

**Call:** Ship the Swift source tree plus `ios/project.yml`; generate the Xcode
project with `xcodegen generate`.
**Alternatives:** Commit a hand-authored `.xcodeproj`.
**Why:** `.xcodeproj` is a merge-hostile generated artifact. A declarative
`project.yml` is reviewable, diffs cleanly, and regenerates deterministically. The
build machine had no Xcode, so the iOS half is written-not-compiled — flagged for
on-device verification in `PROJECT_STATUS.md`.

## 2026-07-18 — v1 is a serverless single-device POC shown via screen mirroring

**Call:** v1 has **no backend at all**. One iPhone app runs everything — camera,
Vision pose, the game (rendered full-screen), and recording. The TV is fed by
plain **screen mirroring** (AirPlay to an Apple TV / AirPlay-2 TV, *or* Chromecast
mirroring, *or* QuickTime to a Mac) — a system feature the app doesn't implement.
PartyKit relay, room codes, cross-device sync, and multiplayer are deferred to **v2**.
**Alternatives considered:** (a) keep the browser-first relay design as v1;
(b) AirPlay as a true external *second screen* (game on TV, controls on phone);
(c) a low-latency **Chromecast Cast-receiver** (game runs on the Chromecast, phone
sends only pose).
**Why mirroring:** The user wants the least-moving-parts POC and to try it on their
existing TV without buying an Apple TV. Mirroring needs zero cast code and works on
any TV. The second-screen and Cast-receiver paths are lower-latency/cleaner but
add real work; the user chose to accept mirroring and revisit latency only if it
bugs them. The real POC risk is **control feel**, testable on the phone screen or
via QuickTime to the Mac — no TV required to iterate.
**Latency note:** iOS→**Chromecast** *mirroring* is a re-encode-and-stream hack
(~1–3s lag) and can hurt a motion game; iOS→**AirPlay** mirroring is native and
low-latency. The user recalls acceptable Chromecast latency and will judge live.
The non-laggy Chromecast option (Cast receiver, pose-only) is parked for later.
**Consequences:** `server/` is parked (v2). `web/` is reused as the game, loaded
into a full-screen `WKWebView`, fed pose via an **in-process JS bridge** instead of
a WebSocket. Recording is done natively with **ReplayKit** screen capture — the
game + a small camera-preview inset are already composited on screen, so one screen
recording yields "person + gameplay together" with no MediaRecorder, clip transfer,
or compositing step. The camera-recorder/clip-receiver/compositor built earlier
move to the v2 browser-relay path. Because transport was abstracted, this is a
swap, not a rewrite. Tradeoff: v1 is **single-device + a mirrored TV** only.

## 2026-07-18 — Reusable SDK; a game is a drop-in

**Call:** The motion-controller platform is a game-agnostic **SDK** (`web/src/sdk/`):
room, `BodyController`, calibration, readiness, diagnostics, recording, and a
`GameHost`. A game implements a small `Game` interface and is mounted via
`createSession({ game, ... })`. *Reach & Dodge* lives in `web/src/games/` as one
consumer.
**Alternatives:** Keep the game and the platform entangled in `main.ts`.
**Why:** The user wants to reuse this across multiple games. Games must read the
`BodyController` abstraction only — never raw pose packets — so the smoothing,
stale-rejection, calibration, and recording are written once and inherited.

## 2026-07-18 — Recording composites on the phone; camera never leaves the device

**Call:** The **phone** records its own camera locally and composites; the
**browser** records the game canvas and ships only the finished gameplay clip to
the phone over the existing relay (dumb passthrough, no backend). The phone stitches
camera + gameplay picture-in-picture offline via AVFoundation and saves one video
to Photos, viewable in the app.
**Alternatives:** Stream the phone camera to the browser and composite there
(breaks the privacy guarantee, needs live video transport); render gameplay on the
phone from game-state events (duplicates every game's renderer — kills reusability).
**Why:** Preserves *camera frames never leave the device* — only the gameplay clip
travels, and only browser→phone, once, at game-over. It needs no backend and no
per-game work (recording is an SDK feature).
**Constraint discovered:** iOS AVFoundation cannot decode WebM/VP8/VP9, so the
browser records **MP4/H.264 when supported** (probed via `MediaRecorder.isTypeSupported`,
WebM fallback). A WebM clip triggers a graceful phone-side fallback (save camera
clip alone + advise using an MP4-capable display). The clip is transferred as
base64 chunks over the relay for the MVP — swappable for a WebRTC DataChannel later.

---

## Open verification items (carry until closed)

- On-device: camera permission flow, Vision coordinate orientation, and the
  Vision→protocol joint mapping accuracy (front-camera mirror + top-left origin).
- Real phone→browser motion-to-render latency on LAN (target median <180 ms).
- Control feel of *Reach & Dodge* under the smoothing/stale-rejection parameters.
- Recording end-to-end: MP4/H.264 capture from the display browser, chunked
  transfer over the relay, on-device PiP composition + Photos save; and the WebM
  fallback path. Confirm the two clips align acceptably at the chosen sync anchors.
- Photos-add permission prompt on the phone.
