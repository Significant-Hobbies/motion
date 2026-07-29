## Why

Motion has an internal iPhone-and-browser proof of concept but no public surface
that explains what it does or gives the Significant Hobbies product a canonical
home. A dedicated landing page can make the concept understandable without
exposing the internal game, relay, or camera surface.

## What Changes

- Add a standalone, responsive public landing surface for
  `motion.significanthobbies.com`.
- Show the product mechanism above the fold with a purpose-built marketing
  visual rather than the internal game.
- Explain the iPhone Vision → on-device game → TV mirroring flow, privacy
  boundary, current proof status, and poor-fit cases in plain language.
- Add canonical metadata, a custom share image, `llms.txt`, public Markdown,
  and an `/api/ai` JSON representation.
- Keep the landing completely isolated from the relative-path, single-file web
  build loaded by the iOS WKWebView.
- Release the static landing at `motion.significanthobbies.com` without
  deploying or linking the internal game.

## Capabilities

### New Capabilities

- `public-product-landing`: A static, accessible marketing and demonstration
  surface that presents Motion accurately to human visitors and agents.

### Modified Capabilities

None.

## Impact

- Adds static landing source at the repository root.
- Reuses the existing Motion logo and game palette; it does not add production
  dependencies.
- Adds public metadata and agent-readable files but no backend, tracking,
  account system, camera collection, or internal-game deployment.
- Does not change the pose protocol, Swift bridge, PartyKit relay, game state,
  or iOS bundle contract.
