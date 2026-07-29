# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

This value describes the public landing surface. Motion itself remains an
iOS-hosted game experiment whose game renderer is web-based.

## Users

People interested in games who want to try a more physical way to play. They
may encounter Motion on a phone, laptop, or television, but they should not need
to understand pose-estimation technology before the experience makes sense.

## Product Purpose

Motion turns body movement into game input. The current proof of concept uses
an iPhone camera and Apple Vision to extract pose data on-device, drives a game
rendered on the phone, and can mirror that game to a larger screen.

Success means a player can understand the mechanic immediately, move their body
and see the game respond, and share or replay a short gameplay moment without
camera footage leaving the phone.

## Positioning

Motion is a game system where the player's body is the controller and the
iPhone does the tracking and rendering locally. The current product does not
require a console, wearable sensor, or uploaded camera stream.

## Operating Context

- The iPhone hosts the camera, Vision pose extraction, Swift bridge, web game,
  and ReplayKit recording.
- Players may mirror the phone screen to a television using an existing
  AirPlay, Chromecast, or wired/screen-capture workflow.
- The same web game remains playable in a browser with debug input for
  development and public demonstration.
- The PartyKit browser-display and multiplayer relay path is parked for a later
  version.

## Capabilities and Constraints

- Motion Maker, Reach & Dodge, and Slice are implemented game modes.
- The web game owns game state; the native host supplies pose input.
- Camera frames must never be transmitted or stored.
- Browser debug input must be labelled separately from real iPhone body
  tracking.
- The iOS app compiles and launches in the simulator. Physical-device camera,
  joint-mapping, mirroring, and ReplayKit behavior remain unverified.
- There is no App Store release, pricing, account system, analytics, or public
  deployment.

## Brand Commitments

The product name is Motion. The existing motion-figure logo at
`web/public/motion-logo.png` is the canonical identity asset. Product language
should lead with play and movement, not developer tooling or pose-estimation
jargon.

## Evidence on Hand

- Runnable browser games and debug controller under `web/`.
- SwiftUI, Vision, WKWebView, and ReplayKit implementation under `ios/`.
- Shared pose protocol under `protocol/`.
- Simulator compilation and launch history recorded in `PROJECT_STATUS.md`.
- No customer testimonials, physical-device validation, usage metrics, or
  commercial proof exists; future surfaces must not fabricate them.

## Product Principles

1. Make movement feel like play before explaining the technology.
2. Show the real mechanic instead of substituting marketing animation for it.
3. Keep camera processing on the player’s phone.
4. Separate demonstrated behavior from unverified physical-device claims.
5. Preserve one game contract across browser debug play and the iPhone host.

## Accessibility & Inclusion

The public web surface must support keyboard navigation, visible focus,
reduced-motion preferences, readable contrast, and responsive layouts. The
product should not imply that every game or movement pattern is suitable for
every player; physical-device validation must include alternatives and
clear-space guidance before release.
