## Context

Motion is a private npm workspace with a Vite/TypeScript game, a SwiftUI iPhone
host, and a parked PartyKit relay. The game build deliberately uses relative
asset paths and an inline entry so it can load from `file://` inside WKWebView.
The current game has a coherent dark visual language, logo, browser debug
controller, and no public landing surface.

The landing must be deployable independently at
`motion.significanthobbies.com` without coupling marketing changes to the
runtime loaded by the iOS app.

## Goals / Non-Goals

**Goals:**

- Make Motion understandable from the first viewport with one concrete action.
- Preserve the existing game identity and demonstrate real product behavior.
- Produce one static deployment directory containing the landing and browser
  demo.
- Expose human-readable and agent-readable product truth.
- Keep all claims bounded by current simulator and browser evidence.

**Non-Goals:**

- Change the game, pose protocol, Swift bridge, recorder, or relay.
- Add analytics, accounts, payments, backend services, or camera collection.
- Claim physical iPhone validation, App Store availability, or production
  readiness.
- Create DNS records or deploy the site.

## Decisions

### Use a dependency-free static landing

The landing will use semantic HTML, CSS, and a small progressive-enhancement
script. A Node built-in-only helper will assemble the deployment directory and
copy the existing game build beneath `/play/`.

This avoids adding a second framework or changing the root dependency graph.
Astro was considered because it is the Fleet default for new marketing sites,
but a one-page surface with no content pipeline does not justify a new build
dependency here.

### Keep the game build authoritative

The landing will not import game internals. It will call the existing web
workspace build and copy its output unchanged. The browser demo will use the
existing debug controller rather than a fabricated animation presented as the
product.

### Preserve the incumbent visual world

The design will derive from Motion's logo, near-black game canvas, teal
tracking accent, red failure accent, high-contrast typography, and body-motion
geometry. The landing may expand the composition and typography but will not
introduce an unrelated portfolio theme.

### Use static agent entrypoints

The deployment bundle will include `llms.txt`, `index.md`, and `api/ai.json`.
A Pages `_redirects` rewrite will expose the JSON at `/api/ai` without a
runtime Worker.

### Treat release as a separate operation

The repository will include deployable output and domain metadata only. A
future release must run the normal Fleet deploy guard, create/verify DNS, deploy
from clean `main`, and update the Fleet catalog from the compatibility hostname
to the canonical hostname.

## Risks / Trade-offs

- **Static marketing source can duplicate product facts** → Keep durable facts
  in `PRODUCT.md` and test the agent surfaces for required wording.
- **Browser debug play can be mistaken for phone tracking** → Label it as a
  mouse/keyboard demo and explain the iPhone mechanism beside it.
- **A second public bundle can drift from the iOS game** → Build `/play/` from
  the existing web workspace rather than copying game source.
- **The audience choice can materially change hero copy** → Finalize
  `PRODUCT.md` and the hero only after the owner confirms the primary user.
- **The old game build may be heavier than the landing** → Keep it off the
  landing critical path and load it only after the visitor chooses the demo.

## Migration Plan

1. Merge the landing source and build helper without deploying.
2. On a separately approved release, build from clean `main`, create or attach
   the Cloudflare surface, and verify the full SHA-tagged/source-parity
   contract.
3. Point `motion.significanthobbies.com` at the approved surface.
4. Verify `/`, `/play/`, `/llms.txt`, `/index.md`, `/api/ai`, and share
   metadata.
5. Roll back by restoring the previous Cloudflare deployment or removing the
   new DNS route; the iOS bundle is unaffected.

## Open Questions

- Is the primary audience families/kids seeking living-room motion play, or
  creators/developers building body-controlled experiences?
