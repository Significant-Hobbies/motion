# motion-server

> **⚠️ Not on the v1 game path.** v1 is a serverless single-device POC (the game
> runs on the phone and is screen-mirrored to a TV; see `../docs/decision-log.md`).
> This relay is the **v2** path for the browser/Chromecast display and multiplayer.
> It's kept green and ready; the v1 game loop doesn't connect to it, but the app's
> optional `AppModel.streamToWebsite` toggle *does* stream pose here today so a
> browser can mirror the phone (a live preview of v2).

The Motion relay: a dumb [PartyKit](https://partykit.io) room that connects one
browser **display** to one iPhone **controller**. It holds no game state — it tags
each socket with a role, enforces one display + one controller per room, broadcasts
peer presence, relays pose/status/calib (controller→display) and start
(display→controller), answers ping with pong, and rate-limits pose packets.

The PartyKit room id **is** the 6-char room code. The display generates the code
(`makeRoomCode`) and connects to `/parties/main/<CODE>`; the controller joins the
same room id. Message shapes live in `../protocol/protocol.ts` (single source of
truth) and are imported directly.

## Develop

```bash
pnpm install
pnpm run dev        # partykit dev — serves on http://localhost:1999
pnpm run typecheck  # tsc --noEmit
```

Both clients open a WebSocket to `ws://localhost:1999/parties/main/<CODE>` and send
a `join` (`{ v, type:"join", role }`) as their first message. Presence, relay, and
`pong` replies follow automatically.

## Deploy

```bash
pnpm run deploy     # partykit deploy
```

PartyKit is now part of Cloudflare, so this can later target our own Cloudflare
account (PartyKit runs on Durable Objects). Keep the transport behind the room
abstraction on the clients so swapping the endpoint stays a one-line change.

Rooms are ephemeral: when a room hits zero connections PartyKit hibernates it and
the in-memory rate buckets reset. No manual TTL is needed.
