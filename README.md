# Motion

**Use your body as a game controller. Your phone watches you move; the game plays on your TV.**

An iPhone runs Apple's Vision body-pose detection on the front camera and uses your
movement to drive a game rendered **full-screen on the phone**. Mirror the phone to
any TV (AirPlay, Chromecast, or QuickTime to a Mac) to play on the big screen.
**Everything runs on the phone — no server, no accounts, no cloud.**

```
 iPhone:  front camera ─► Vision pose ─► game (WKWebView) ─► screen
                                                              │ mirror (AirPlay / Chromecast / QuickTime)
                                                              ▼
                                                             TV
```

## v1 (this POC) vs v2

**v1 is deliberately serverless and single-device** — the fastest path to answering
the only question that matters: *does body-control feel good?* Multiplayer, a
browser display, Chromecast receivers, and cross-network play are **v2** and already
have their scaffolding in the repo (parked).

| | v1 (now) | v2 (parked) |
|---|---|---|
| Devices | one iPhone + a mirrored TV | phones + a shared browser/TV |
| Transport | in-process JS bridge | PartyKit relay (`server/`) |
| Display | game on phone, screen-mirrored | browser (`web/`) + Chromecast receiver |
| Recording | ReplayKit screen capture | camera-record + composite |
| Players | 1 | 1–4 |

## Repository layout

| Dir         | What                                                                      |
|-------------|---------------------------------------------------------------------------|
| `protocol/` | v1 wire/bridge message shapes — single source of truth                    |
| `web/`      | The game: TypeScript + Vite + Canvas. A reusable **SDK** + `Game` interface; *Reach & Dodge* is one consumer. Runs in a phone WebView (v1) or a browser (v2). |
| `ios/`      | SwiftUI app: camera, Vision pose, WebView game host, JS pose bridge, ReplayKit recording |
| `server/`   | PartyKit relay — **parked for v2**                                         |
| `docs/`     | Decision log / journey                                                     |

## Try the game right now (no phone, no iOS)

The game is fully playable in a desktop browser with a keyboard/mouse debug
controller — the quickest way to feel *Reach & Dodge* and iterate on it.

```bash
npm install
npm --workspace web run dev      # http://localhost:5173
```

Open `http://localhost:5173/?debug=1`: **mouse = hands, arrow keys = lean, space = squat.**

## Run v1 on your iPhone

The phone renders the game; you mirror it to a TV. The web game is **bundled into the
app** (`ios/Resources/webgame`), so no dev server or Mac network is needed to play.

1. Generate + open the Xcode project:
   ```bash
   cd ios && brew install xcodegen && xcodegen generate && open Motion.xcodeproj
   ```
2. Set your signing team (a free Apple ID works).
3. Run on a **physical iPhone** (camera required). Grant camera + Photos permissions.
4. Stand back so your whole body is in frame, calibrate, play.
5. **Mirror to a TV**: Control Center → Screen Mirroring → your Apple TV / AirPlay-2
   TV / Chromecast (or use QuickTime over USB to view on the Mac).
6. Tap **Record** to save a screen recording (game + your camera inset) to Photos.

**Iterating on the web game from the phone?** Run `npm --workspace web run dev`, set
`GameConfig.forceDevServer = true`, point the app's dev-server IP at your Mac, and
refresh the bundle after changes with `./scripts/sync-webgame.sh`.

## Status & the main risk

MVP POC. See [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) and
[`docs/decision-log.md`](./docs/decision-log.md). The main product risk is **control
feel**, not infrastructure — which is exactly why v1 strips out all the servers.

> ⚠️ The iOS app is written but **not yet built on-device** (no Xcode in the build
> environment). Key things to verify first: that ReplayKit captures the WebView game
> content, and that the Vision left/right joint mapping matches the player. See the
> verify list in `PROJECT_STATUS.md`.
