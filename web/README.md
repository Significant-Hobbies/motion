# Motion — Web (motion-controller SDK + display)

The **web** side turns any browser/TV into a Motion screen. It is split into a
reusable, game-agnostic **SDK** and a thin **host app** that picks a game: the
phone (bridge transport) and the `?room=MOTION` / `?game=motion-maker` browser
paths run *Motion Maker* (grab/toss playground); the plain-browser socket default
runs *Reach & Dodge*. Plain TypeScript + Canvas 2D (no React, no engine).
Networking via `partysocket`.

## Layout

```
src/
  sdk/            # reusable motion-controller platform
    index.ts        # public surface: createSession() + GameHost + all types
    room.ts         # PartySocket relay wrapper (display side)
    controller.ts   # BodyController interface + PoseControllerBase (shared smoothing/stale) + PoseController
    keyboard-debug.ts
    bridge.ts       # embedded/v1 JS bridge: BridgeController + window.__motion + native events
    canvas.ts       # letterboxed 16:9 CanvasSurface
    skeleton.ts     # shared skeleton draw
    calibration.ts  # readiness gate + calibration handshake
    diagnostics.ts  # ?debug overlay
    recording.ts    # record game canvas → ship clip to phone
    game.ts         # Game interface + CanvasRenderer
    types.ts        # shared SDK types
  games/
    reach-dodge/index.ts    # a Game implementation (timed round)
    motion-maker/index.ts   # interactive live-mirror playground (grab/toss objects)
  app/
    main.ts         # host: config + game selection + mount
    overlay.ts      # HTML screens (SessionScreenRenderer)
  config.ts
```

The **SDK is genuinely reusable**: a new game implements the `Game` interface
(`init/update/render/isOver/result/reset`), reading input ONLY through the
`BodyController` abstraction and drawing through `Renderer` — never raw pose
packets. `createSession({ game, mount, options, screens })` wires up the room,
the active controller (pose or keyboard-debug), the readiness gate, the
fixed-timestep loop + interpolated render, tracking-loss pause/resume, results,
and recording. Swapping the game is a one-line change in `app/main.ts`.

## Run

```bash
npm install
npm run dev          # vite dev server on http://localhost:5173
npm run typecheck    # tsc --noEmit
npm run build        # tsc && vite build
```

The dev relay defaults to `http://127.0.0.1:1999` (PartyKit). Override with
`?server=<host>` or the `VITE_PARTY_HOST` env var.

## Play without a phone (debug mode)

Open `http://localhost:5173/?debug=1` (or press `d` to toggle). This swaps in a
keyboard/mouse controller that implements the same `BodyController` interface,
so the whole game is playable and testable with no iPhone.

**Debug controls**

- **Mouse** — moves both hands (used to hit left/right targets, or reach objects
  in the motion maker).
- **Left mouse / Space** — close both hands (grab, for the motion maker).
- **← / A** — lean left, **→ / D** — lean right (dodge LEAN obstacles).
- **↓ / S** — squat (dodge DUCK obstacles).
- Move the mouse once to pass the readiness gate.

The diagnostics overlay (RTT, pose rate, seq, latency, tracking quality) shows
whenever the page is opened with `?debug=1`.

## Motion maker (interactive mirror)

An interactive body-controlled **playground**: the browser is a live mirror that
draws your pose as a clean avatar, plus floating objects you reach for with your
hands. **Close a hand near an object to grab it**, move it, and **open the hand
to release** (tossing it with your hand's recent velocity). Drop objects into the
target bin to score. It's upper-body only — head / torso / hands, no legs or
squat — so it works seated at a desk.

- **With a phone**: open `http://localhost:5173/?room=MOTION`. This forces room
  `MOTION` on the socket relay, shows the pairing code, and — as soon as the
  phone connects — drops **straight into the playground** (no mirror-test /
  readiness ceremony; it's a live mirror, not a timed round). Hand open/close
  comes from the phone's Vision hand-pose (`PosePacket.hands`, 0 = fist … 1 =
  open palm), smoothed like the joints; absent hand data defaults to open so
  nothing falsely grabs.
- **Without a phone**: open `http://localhost:5173/?room=MOTION&debug=1` (or
  `?game=motion-maker&debug=1`). The **mouse is a hand**; **hold left mouse or
  Space to close the hand** (grab), release to open (drop). Move the mouse once
  to begin.
- **Grab/release thresholds**: a hand counts as *closed* when openness `≤ 0.55`
  (`GRAB_THRESHOLD`) and grabs the nearest free object within reach on the
  open→closed edge; a held object *releases* when the hand opens past `0.72`
  (`RELEASE_THRESHOLD`). One object per hand.

`?game=motion-maker` also selects it without forcing a specific room.

## Recording (opt-in)

Motion's co-op replay is split: the **phone** records its own camera locally
and composites picture-in-picture offline; the **browser** records only the game
canvas and ships the finished clip to the phone over the relay.

- **Toggle**: recording is **off by default**. Turn it on with the *Record
  gameplay clip* checkbox on the pairing screen, or with `?record=1`.
- **Codec caveat (important)**: iOS AVFoundation **cannot decode WebM/VP8/VP9**.
  For the phone to composite the two clips into one MP4, the gameplay clip must
  be **H.264/MP4**. The SDK probes `MediaRecorder.isTypeSupported` in this
  order and records the first that works:
  1. `video/mp4;codecs=h264`
  2. `video/mp4`
  3. `video/webm;codecs=vp9`  *(fallback — phone saves two separate clips)*
  4. `video/webm`             *(fallback)*
  The chosen mime is sent in `RecMetaMessage.mime`. If only WebM is available it
  still transfers, but the console + diagnostics overlay warn that MP4 is needed
  for on-device compositing. **Use a browser with MP4 MediaRecorder support**
  (recent Chromium; Safari 16.4+ supports `video/mp4` capture) for the full
  phone-compositing flow.
- **Transfer**: at game-over the clip is sliced into ≤500 KB raw pieces, base64
  each (~667 KB, under PartyKit's ~700 KB message cap), and sent sequentially as
  `RecChunkMessage`s with socket backpressure respected.
- **Browser-side download (no phone)**: when recording is on but no controller
  peer is connected (debug/no-phone), the clip is still recorded and a
  **download link** appears so it's testable without a phone.

Recording lives entirely in the SDK (`sdk/recording.ts`, driven by `GameHost`)
and knows nothing about any particular game.

## Embedded (bridge) mode — serverless single-device v1

Motion's v1 POC is **serverless and single-device**: the iOS app hosts this web
game inside a `WKWebView` shown full-screen on the phone (mirrored to a TV via
AirPlay). The phone runs the camera + Vision pose **locally** and injects pose
**in-process via a JavaScript bridge** — no WebSocket, no relay, no room pairing.
The socket transport above stays for v2 (browser + multiplayer).

- **Transport select** (`config.ts` → `TRANSPORT`): defaults to `bridge` when
  running inside the WKWebView host (`window.webkit.messageHandlers.motion`
  exists) **or** `?transport=bridge` is present; otherwise `socket`. So a plain
  browser is unchanged — it always takes the socket path unless you force bridge.
- In bridge mode the SDK **skips** room creation, pairing, the room-code screen,
  the mirror test, and the readiness checklist (the phone already ran its own
  readiness gate). The session sits on a blank `bridge-idle` surface until native
  calls `start()`, then runs the normal game loop. Tracking-loss → pause is still
  honored via `setTracking`.

**Native → web** (native calls these on `window.__motion`):

```ts
window.__motion = {
  pushPose(json),        // one pose frame — PosePacket shape {seq,sentAt,quality,joints};
                         //   accepts an object or a JSON string. BridgeController consumes it.
  setTracking(state),    // 'ok' | 'lost' | 'partial' | 'too_close' | 'too_far'
                         //   | 'raise_phone' | 'low_light' — anything ≠ 'ok' pauses the game.
  start(),               // begin / restart the game (readiness already satisfied on the phone).
  stop(),                // end / abort the current game back to idle.
  calibrated(),          // calibration finished on the phone (no-op gate in bridge mode).
};
```

**Web → native** (emitted via `window.webkit.messageHandlers.motion.postMessage`,
a no-op when that handler is absent, e.g. a plain browser). Native uses these to
bracket its **ReplayKit** screen recording:

```ts
{ event: 'ready' }                 // the game canvas is up
{ event: 'gameStart' }             // a game just started
{ event: 'gameOver', result }      // a game ended; `result` is the GameResult (or null)
{ event: 'score', value }          // final score (number), emitted just before gameOver
{ event: 'restart' }               // a replay is starting (emitted before gameStart on replays)
```

**Recording**: in bridge/v1 mode the browser does **not** run `MediaRecorder` —
the native app captures the screen with ReplayKit and brackets it with the
`gameStart` / `gameOver` events above. The socket-mode canvas recording (below)
is left intact for v2.

## Pairing with the server + phone

The **PartyKit room id IS the 6-char code**. The display generates it with
`makeRoomCode()` and connects to that room; the phone joins the same room id.
The relay forwards pose packets controller→display; all game state is here.
The room code stays stable across socket reconnects.

Share a known room with `?room=ABC234` (e.g. to rejoin after a refresh).
