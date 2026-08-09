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
have their scaffolding in the repo (parked). One live exception: the app can
optionally *also* stream pose to the PartyKit relay (`AppModel.streamToWebsite`) so
a browser mirrors your motion — a working preview of the v2 relay path that the
local game does not depend on.

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
| `web/`      | The game: TypeScript + Vite + Canvas. A reusable **SDK** + `Game` interface. The phone (bridge) runs *Motion Maker* (grab/toss playground); *Reach & Dodge* is the plain-browser socket consumer. Runs in a phone WebView (v1) or a browser (v2). |
| `ios/`      | SwiftUI app: camera, Vision pose, WebView game host, JS pose bridge, ReplayKit recording |
| `server/`   | PartyKit relay — **parked for v2**                                         |
| `docs/`     | Decision log / journey                                                     |

## Try the game right now (no phone, no iOS)

The game is fully playable in a desktop browser with a keyboard/mouse debug
controller — the quickest way to feel the games and iterate on them.

```bash
pnpm install
pnpm --filter motion-web run dev      # http://localhost:5173
```

- Open `http://localhost:5173/?debug=1` for **Reach & Dodge** (the plain-browser
  default): **mouse = hands, arrow keys = lean, space = squat.**
- Open `http://localhost:5173/?game=motion-maker&debug=1` for **Motion Maker** —
  the same playground the phone runs: **mouse = a hand, hold left mouse / space =
  close the hand (grab), release to drop.**

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

**Iterating on the web game from the phone?** Run `pnpm --filter motion-web run dev`, set
`GameConfig.forceDevServer = true`, point the app's dev-server IP at your Mac, and
refresh the bundle after changes with `./scripts/sync-webgame.sh`.

## Checks and public landing release

Pushes and pull requests run the repository-owned web/server typecheck, web
build, and static landing contract. Physical-device and signing evidence stays
manual because hosted CI cannot exercise the camera path.

```bash
pnpm check
```

The public landing is a separate static Cloudflare Pages surface. Release it
only from a clean, synchronized `main` after exact-main CI is green:

```bash
pnpm deploy
```

The parked PartyKit relay keeps its separate `server` deploy command and is not
released by the landing command.

## Status & the main risk

MVP POC. See [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) and
[`docs/decision-log.md`](./docs/decision-log.md). The main product risk is **control
feel**, not infrastructure — which is exactly why v1 strips out all the servers.

> ⚠️ The iOS app **compiles cleanly for the iOS Simulator** but has **not yet run
> on a physical device** (the Simulator has no camera). Key things to verify first:
> that ReplayKit captures the WebView game content, and that the Vision left/right
> joint mapping matches the player. See the verify list in `PROJECT_STATUS.md`.
