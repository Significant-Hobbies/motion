# Motion — Agent Instructions

Child project of the fleet. Follow the root fleet standard (`../AGENTS.md`) plus
these project rules.

## Architecture in one breath

Phone (`ios/`, Vision pose) → relay room (`server/`, PartyKit) → browser
(`web/`, Canvas game). The **browser owns all game state**; the server is a dumb
relay; the phone sends input, never decisions. `protocol/protocol.ts` is the
single source of truth for the wire format — change it there first, then mirror
into `ios/Sources/Motion/Net/Protocol.swift` and bump `PROTOCOL_VERSION`.

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
npm install
npm run dev            # relay :1999 + web :5173
# open http://localhost:5173/?debug=1  → mouse=hands, arrows=lean, space=squat
npm run typecheck
```

iOS builds only on a Mac with Xcode 16+ against a physical device
(`cd ios && xcodegen generate`).
