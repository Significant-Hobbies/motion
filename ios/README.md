# Motion — iOS (v1: serverless, single device)

Turns an iPhone into a full-body motion controller **and** the game screen. The phone
does everything: the front camera runs Apple **Vision** body-pose detection on-device,
the web game runs inside a full-screen `WKWebView`, pose is injected into the game
**in-process via a JavaScript bridge** (no server, no WebSocket, no pairing), and the
whole screen (game + a small camera inset) is recorded with **ReplayKit** as one video.

You watch on a TV by **mirroring the phone** via the OS (AirPlay / Chromecast mirror from
Control Center). The app implements no casting of its own.

> The v2 browser/relay path (WebSocket relay, room pairing, offline PiP compositing) is
> **parked** in-tree — files carry a `PARKED for v2` header and nothing in the v1 flow
> uses them.

## Prerequisites

- Xcode 16+ (Swift 6 / iOS 17 SDK)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`
- A physical iPhone (the simulator has no usable camera; ReplayKit capture also needs a device)
- For the dev-server loop: the Motion **web** app running on your Mac (see `../web`)

## Generate & build

```sh
cd ios
xcodegen generate
open Motion.xcodeproj
```

In Xcode: select the `Motion` target → **Signing & Capabilities** → set your **Team**
and (if needed) a unique **Bundle Identifier** (default `com.motion.controller`).

## Run (dev-server loop — the default)

1. On your Mac, start the web game's Vite dev server:

   ```sh
   npm --workspace web run dev
   ```

   It serves on port **5173**.

2. Find your Mac's **LAN IP** (System Settings → Wi-Fi → Details). Either edit
   `MAC_LAN_IP` in `Sources/Motion/Game/GameConfig.swift`, or set it at runtime in the
   app: on the setup screen tap the gear icon and type the IP into **Dev server IP**.
   The phone and Mac must be on the same Wi-Fi.

3. Run on the connected device. Approve the **camera** (and, on first save, **Photos-add**)
   prompts. The WKWebView loads `http://<MAC_LAN_IP>:5173/?transport=bridge` — an
   insecure origin is fine because bridge mode does no `getUserMedia`/`MediaRecorder`.

4. Play: frame your whole body → **Calibrate** → the game goes full-screen. Optionally arm
   the red **Record** toggle. **Mirror the phone to a TV** via Control Center (AirPlay /
   Chromecast mirror).

## "Pure app" finish (bundled build — no Mac, no network)

1. Build the web game: `npm --workspace web run build` (emits `web/dist`).
2. In Xcode, drag `web/dist` into the app target as a **folder reference** named
   `webgame` ("Create folder references", **not** "Create groups").
3. Set `GameConfig.source = .bundled` in `Sources/Motion/Game/GameConfig.swift`.
   The webview then loads `webgame/index.html` via `loadFileURL`.

## On-device verification (MUST check)

- **ReplayKit captures the WKWebView game canvas.** WKWebView renders out-of-process;
  confirm the saved video actually shows the game (not a blank/black webview region).
- **ReplayKit captures the camera inset.** Confirm the `AVCaptureVideoPreviewLayer` inset
  appears in the saved video (not black).
- If the game canvas is blank in the recording, use the documented fallback in
  `Sources/Motion/Recording/ScreenRecorder.swift`: switch to a bundled `file://` load
  and/or render a native camera-inset + HUD instead of the webview.
- **Left/right joint mapping** (see `PoseEstimator.swift`): the mirrored front-camera
  buffer means Vision's left = your right; confirm the on-screen skeleton matches you.

## Privacy

Camera frames are processed in-memory and discarded each cycle — never written to disk on
their own, never uploaded. The screen recording (game + camera inset) is captured and
saved to Photos entirely on-device.
