## Why

Motion has a working iPhone-and-browser proof of concept but no public surface
that explains what it does, demonstrates the experience, or gives the
Significant Hobbies product a canonical home. A dedicated landing bundle can
make the product understandable without changing the iOS-bundled game or
claiming physical-device validation that has not happened.

## What Changes

- Add a standalone, responsive public landing surface for
  `motion.significanthobbies.com`.
- Show the product mechanism above the fold and link to a keyboard/mouse-driven
  browser demonstration built from the existing web game.
- Explain the iPhone Vision → on-device game → TV mirroring flow, privacy
  boundary, current proof status, and poor-fit cases in plain language.
- Add canonical metadata, a custom share image, `llms.txt`, public Markdown,
  and an `/api/ai` JSON representation.
- Keep the landing build isolated from the relative-path, single-file web build
  loaded by the iOS WKWebView.
- Prepare source and deployment metadata only. DNS and production deployment
  remain separately approved.

## Capabilities

### New Capabilities

- `public-product-landing`: A static, accessible marketing and demonstration
  surface that presents Motion accurately to human visitors and agents.

### Modified Capabilities

None.

## Impact

- Adds static landing source and a dependency-free build helper at the
  repository root.
- Reuses the existing Motion logo, game palette, and web build; it does not add
  production dependencies.
- Adds public metadata and agent-readable files but no backend, tracking,
  account system, camera collection, DNS change, or deployment.
- Does not change the pose protocol, Swift bridge, PartyKit relay, game state,
  or iOS bundle contract.
