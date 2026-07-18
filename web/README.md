# Motion — Web (motion-controller SDK + display)

The **web** side turns any browser/TV into a Motion screen. It is split into a
reusable, game-agnostic **SDK** and a thin **host app** that runs one game
(*Reach & Dodge*). Plain TypeScript + Canvas 2D (no React, no engine).
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
    reach-dodge/index.ts   # a Game implementation
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

- **Mouse** — moves both hands (used to hit left/right targets).
- **← / A** — lean left, **→ / D** — lean right (dodge LEAN obstacles).
- **↓ / S / Space** — squat (dodge DUCK obstacles).
- Move the mouse once to pass the readiness gate.

The diagnostics overlay (RTT, pose rate, seq, latency, tracking quality) shows
whenever the page is opened with `?debug=1`.

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
