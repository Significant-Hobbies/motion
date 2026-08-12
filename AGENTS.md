# Motion — Agent Instructions

This repository is independently operable. Its tracked instructions and
commands are authoritative; no sibling Fleet checkout is required. Keep changes
scoped, verify work with repo-local checks, and record durable follow-up in this
repository's GitHub Issues.

## Architecture in one breath

**v1 (shipped) is serverless and single-device.** The phone (`ios/`, Vision pose)
hosts the web game (`web/`, Canvas) inside a full-screen `WKWebView` and injects
pose **in-process via a JS bridge** (`ios/.../Game/PoseBridge.swift` ↔
`web/src/sdk/bridge.ts`) — no relay, no WebSocket, no pairing. The phone runs
*Motion Maker* (the on-phone game selected whenever the transport is `bridge`);
you screen-mirror the phone to a TV. The **web owns all game state**; the phone
sends input, never decisions.

**v2 (parked, kept green) is the browser/multiplayer relay path**: phone →
`server/` (PartyKit) → browser display, running *Reach & Dodge* on the `socket`
transport. One live exception today: `AppModel.streamToWebsite` optionally streams
pose to that relay so a browser mirrors the phone — a preview of v2 the local game
doesn't depend on.

`protocol/protocol.ts` is the single source of truth for the wire format — change
it there first, then mirror into `ios/Sources/Motion/Net/Protocol.swift` and bump
`PROTOCOL_VERSION`. See `docs/architecture/how-it-works.md` for the full walkthrough.

## Build order (do not skip ahead)

1. iOS camera + landmark-debug screen
2. Normalized `BodyController`
3. Browser body mirror
4. Room-code pairing
5. Readiness gate + calibration
6. Reach & Dodge
7. Latency + tracking diagnostics
8. TestFlight hardening
9. **Only then** multiplayer

Do **not** implement Cast, AirPlay, accounts, multiple games, or multiplayer
before the single-player game is demonstrably enjoyable. The product risk is
**control feel**, not server infrastructure.

## Rules

- The web game must always be playable with the keyboard/mouse debug controller
  (`?debug=1`) — no phone required to iterate on feel.
- Games read the `BodyController` abstraction only, never raw pose packets.
- **Never transmit or store camera frames.** Only normalized joints leave the phone.
- Keep the transport behind the room abstraction (PartyKit is swappable for a
  self-hosted Cloudflare Durable Object later).
- Small diffs. Keep `protocol/`, `web/`, `server/`, and the Swift mirror in sync.

## Verify locally

```bash
pnpm install
pnpm run dev            # relay :1999 + web :5173
# Reach & Dodge:  http://localhost:5173/?debug=1  → mouse=hands, arrows=lean, space=squat
# Motion Maker:   http://localhost:5173/?game=motion-maker&debug=1  → mouse=a hand, hold left mouse/space=grab
pnpm check              # full TypeScript quality gate and debt ratchets
```

iOS builds only on a Mac with Xcode 16+. Generate the CocoaPods workspace with
`cd ios && xcodegen generate && pod install --deployment`, then build the
`Motion.xcworkspace` scheme. `pnpm quality:swift` checks the Swift formatting
and unused-code ratchets after a build when `MOTION_INDEX_STORE` points to its
index store. Camera + ReplayKit paths still need a **physical device** to verify
(see `PROJECT_STATUS.md`).
