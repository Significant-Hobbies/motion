## Context

Motion is a private npm workspace with a Vite/TypeScript game, a SwiftUI iPhone
host, and a parked PartyKit relay. The game build deliberately uses relative
asset paths and an inline entry so it can load from `file://` inside WKWebView.
The current game has a coherent dark visual language, logo, browser debug
controller, and no public landing surface.

The landing will deploy independently at `motion.significanthobbies.com`
without coupling marketing changes to the runtime loaded by the iOS app.

## Goals / Non-Goals

**Goals:**

- Make Motion understandable from the first viewport with one concrete action.
- Preserve the existing game identity and demonstrate real product behavior.
- Produce one static landing directory with no internal application routes.
- Expose human-readable and agent-readable product truth.
- Keep all claims bounded by current simulator and browser evidence.

**Non-Goals:**

- Change the game, pose protocol, Swift bridge, recorder, or relay.
- Add analytics, accounts, payments, backend services, or camera collection.
- Claim physical iPhone validation, App Store availability, or production
  readiness.
- Deploy or link the internal game, relay, or camera surface.

## Decisions

### Use a dependency-free static landing

The landing will use semantic HTML, CSS, and a small progressive-enhancement
script. The tracked landing directory is itself the deployment artifact.

This avoids adding a second framework or changing the root dependency graph.
Astro was considered because it is the Fleet default for new marketing sites,
but a one-page surface with no content pipeline does not justify a new build
dependency here.

### Keep the internal game private

The landing will not import game internals, link to a game route, or publish
the existing web build. A purpose-built motion figure may illustrate the
mechanic, but it will be clearly presentational and make no claim of live
tracking.

### Preserve the incumbent visual world

The design will derive from Motion's logo, near-black game canvas, teal
tracking accent, red failure accent, high-contrast typography, and body-motion
geometry. The landing may expand the composition and typography but will not
introduce an unrelated portfolio theme.

### Use static agent entrypoints

The deployment bundle will include `llms.txt`, `index.md`, and `api/ai.json`.
A Pages `_redirects` rewrite will expose the JSON at `/api/ai` without a
runtime Worker.

### Release as a standalone Pages surface

The landing will be released as a static Cloudflare Pages surface after the
normal Fleet deploy guard, responsive review, clean-main verification, and
custom-domain setup. The internal application remains undeployed.

## Risks / Trade-offs

- **Static marketing source can duplicate product facts** → Keep durable facts
  in `PRODUCT.md` and test the agent surfaces for required wording.
- **The marketing visual can be mistaken for live tracking** → Describe it as
  an illustration and do not attach camera or pointer-driven pose input.
- **The landing can accidentally expose internal routes** → Deploy only the
  dedicated landing directory and verify the final request inventory.
- **The audience choice can materially change hero copy** → Finalize
  `PRODUCT.md` and the hero only after the owner confirms the primary user.
- **The public concept can outrun the proof** → Keep simulator and
  physical-device validation language explicit.

## Migration Plan

1. Merge the standalone landing source after its design-review receipt passes.
2. Build and deploy the static directory from clean `main`.
3. Attach `motion.significanthobbies.com` to the Pages surface.
4. Verify `/`, `/llms.txt`, `/index.md`, `/api/ai`, metadata, and the absence of
   internal game routes or assets.
5. Roll back by restoring the previous Pages deployment or removing the new
   DNS route; the internal iOS and web application remain unaffected.

## Open Questions

None. The owner confirmed the primary audience is people interested in games,
not a developer platform or a kids-only product.
