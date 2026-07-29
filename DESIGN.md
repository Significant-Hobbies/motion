---
name: Motion
description: Body-controlled games with an iPhone as the local motion system.
colors:
  night: "#05070d"
  panel: "#0d1220"
  ink: "#f4f7ff"
  muted: "#8a95b5"
  motion-teal: "#35e0c8"
  paper-muted: "#47526c"
  paper-copy: "#4b5670"
  paper-rule: "#c9ced9"
  teal-copy: "#123b35"
  impact-red: "#ff4d6d"
  warning: "#ffcc33"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(3.5rem, 9vw, 7rem)"
    fontWeight: 800
    lineHeight: 0.92
    letterSpacing: "-0.055em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.2em"
rounded:
  sm: "8px"
  md: "12px"
  lg: "20px"
spacing:
  xs: "8px"
  sm: "16px"
  md: "24px"
  lg: "32px"
  xl: "56px"
components:
  button-primary:
    backgroundColor: "{colors.motion-teal}"
    textColor: "{colors.night}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "16px 22px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "32px"
---

# Design System: Motion

## Overview

**Creative North Star: "Motion Arcade"**

Motion looks like a game waking up in a dark room. Its existing logo—the
bright teal body repeated across several positions—is the canonical visual
idea: movement is visible as a trail, and the person is the input. The system
is energetic and game-first without falling into generic neon gamer chrome.

The world stays near-black so motion, score, and state changes can carry the
light. Interfaces are direct, high-contrast, and sparse enough to read from a
television or across a room.

**Key Characteristics:**

- Near-black fields with one luminous motion accent.
- Human geometry and movement trails instead of decorative gradients.
- Short, confident game language with large readable moments.
- Red and yellow reserved for actual game state, never decoration.
- The existing Motion logo is preserved exactly.

## Colors

The palette is a dark game field lit by a single tracking signal.

### Primary

- **Tracking Teal** (`#35e0c8`): Motion trails, primary actions, successful
  tracking, and the product wordmark accent.

### Secondary

- **Impact Red** (`#ff4d6d`): Tracking loss, danger, misses, and destructive
  game state only.
- **Ready Yellow** (`#ffcc33`): Reconnection, readiness, and temporary warning
  state.

### Neutral

- **Night Field** (`#05070d`): The dominant page and game background.
- **Control Panel** (`#0d1220`): Focused content containers and overlays.
- **Screen Ink** (`#f4f7ff`): Primary text and high-value game information.
- **Distance Blue** (`#8a95b5`): Supporting copy and secondary labels.
- **Paper Muted** (`#47526c`) and **Paper Copy** (`#4b5670`): Supporting
  text on the light mechanism surface.
- **Paper Rule** (`#c9ced9`): Dividers between mechanism steps.
- **Teal Copy** (`#123b35`): Long-form copy on Tracking Teal.

**The Tracking Signal Rule.** Teal identifies motion or the next action. It
does not become a generic wash across every surface.

## Typography

**Display Font:** System sans-serif, led by San Francisco on Apple devices.
**Body Font:** The same system sans-serif stack.

**Character:** Fast, familiar, and legible at distance. Weight and scale create
the arcade confidence; the typeface itself stays invisible.

### Hierarchy

- **Display** (800, `clamp(3.5rem, 9vw, 7rem)`, 0.92): One short game or
  product statement.
- **Headline** (750, `clamp(2rem, 5vw, 4rem)`, 1): Section outcomes and game
  moments.
- **Title** (700, 1.25–1.5rem, 1.2): Named mechanisms and compact panels.
- **Body** (400, 1rem, 1.65): Explanations capped near 65 characters.
- **Label** (700, 0.75rem, 0.2em, uppercase): State, sequence, and category
  labels.

**The Across-the-Room Rule.** Important state and the primary action must remain
legible at television distance; small labels may support them but never replace
them.

## Layout

The internal game is full-bleed. Public compositions use a centered maximum
width around 1200px with one dominant motion stage and a restrained supporting
column. Sections use generous vertical intervals and avoid card grids.

At narrow widths, the stage becomes a compact square and content follows in
document order. Touch targets remain at least 44px. The logo and motion figure
may overlap the composition but never obscure text or controls.

## Elevation & Depth

Depth comes from tonal layering, faint teal illumination, and translucent
motion trails. Panels may use a deep ambient shadow against the night field,
but surfaces do not stack into dashboard-style layers.

**The Dark-Room Rule.** A surface earns elevation only when it focuses play or
explanation; decorative cards stay flat or disappear.

## Shapes

Motion uses compact 8–20px radii, circular joints, and long rounded limbs.
Panels are soft enough to feel modern but not bubbly. Borders are low-contrast
white or teal strokes, used to clarify edges against black rather than decorate
the page.

## Components

### Buttons

- **Shape:** Compact rounded rectangle (`12px`) with a minimum 44px height.
- **Primary:** Tracking Teal background, Night Field text, bold uppercase label.
- **Hover / Focus:** Slight brightness lift and a visible teal/white focus ring;
  no large translation.
- **Ghost:** Transparent field, Screen Ink text, and a quiet white border.

### Cards / Containers

- **Corner Style:** `20px` for focused panels.
- **Background:** Control Panel or translucent Night Field.
- **Shadow Strategy:** One ambient shadow only for focused content.
- **Border:** `1px` low-contrast white or teal.
- **Internal Padding:** 24–32px.

### Navigation

Navigation is minimal: the unchanged Motion logo/wordmark, one Significant
Hobbies context link, and the page’s primary explanation action. Mobile keeps
the same labels and does not introduce a hidden application menu.

### Illustration exceptions

The phone frame uses a `28px` radius and its camera slot, body joints, and limbs
use pill or circular radii. These are representational geometry, not container
tokens. Oversized background words use responsive display sizes outside the
content hierarchy because they are non-reading decorative texture.

### Motion Figure

The signature component is a simplified human skeleton with circular joints,
rounded limbs, and progressively dimmer teal trails. It illustrates movement;
it must never imply that the public landing is reading the visitor’s camera.

## Do's and Don'ts

### Do:

- **Do** preserve `web/public/motion-logo.png` exactly.
- **Do** use the motion trail to explain body-as-controller.
- **Do** keep the page predominantly Night Field and reserve teal for motion
  and action.
- **Do** label simulator evidence and physical-device gaps plainly.

### Don't:

- **Don't** expose or link the internal web game, relay, room codes, or camera
  mode.
- **Don't** add cyan-purple gradients, gaming HUD clutter, or generic esports
  typography.
- **Don't** use Impact Red or Ready Yellow as decorative accents.
- **Don't** fabricate live tracking, customers, testimonials, availability, or
  performance numbers.
