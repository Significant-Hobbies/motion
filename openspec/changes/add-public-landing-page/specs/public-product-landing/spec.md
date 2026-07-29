## ADDED Requirements

### Requirement: First viewport explains Motion
The landing SHALL address people interested in games, state the concrete
outcome and product mechanism, and provide one primary next action without
requiring a scroll.

#### Scenario: Visitor opens the landing
- **WHEN** a visitor loads the public root page
- **THEN** the first viewport identifies Motion as body-controlled play driven by an iPhone and offers one clearly labelled action without framing it as a developer tool or kids-only product

### Requirement: Marketing visual remains presentational
The site SHALL use a purpose-built marketing visual to explain body-controlled
play and SHALL NOT expose, embed, or link to the internal game.

#### Scenario: Visitor views the product illustration
- **WHEN** a visitor sees the motion figure or gameplay composition
- **THEN** the page presents it as an illustration without camera access, live tracking, or an internal application route

### Requirement: Landing does not change the iOS game contract
The landing build MUST leave the existing web workspace output semantics,
relative asset base, inline entry, pose protocol, and Swift bridge unchanged.

#### Scenario: Landing bundle is built
- **WHEN** the public deployment bundle is assembled
- **THEN** only the dedicated landing directory is included and the internal web workspace remains untouched

### Requirement: Product claims are evidence bounded
The landing SHALL distinguish browser and simulator evidence from unverified
physical-iPhone behavior and SHALL NOT claim App Store availability, production
readiness, customers, testimonials, or performance numbers without evidence.

#### Scenario: Visitor reads proof and availability copy
- **WHEN** the landing describes current product status
- **THEN** it names the browser and simulator proof and identifies physical-device validation as outstanding

### Requirement: Privacy boundary is explicit
The landing SHALL state that camera frames remain on the iPhone and SHALL NOT
add analytics, tracking pixels, account collection, or camera access.

#### Scenario: Visitor evaluates privacy
- **WHEN** a visitor reads the mechanism or privacy section
- **THEN** the page explains that Vision extracts motion on-device and that camera frames are neither transmitted nor stored

### Requirement: Human and agent discovery surfaces are available
The deployment bundle SHALL provide canonical metadata, share metadata,
`llms.txt`, public Markdown, and JSON at `/api/ai` with consistent product
facts.

#### Scenario: Agent reads the product
- **WHEN** a client requests `/llms.txt`, `/index.md`, or `/api/ai`
- **THEN** it receives a static representation consistent with the human landing page

### Requirement: Landing is accessible and responsive
The landing SHALL be keyboard-operable, preserve visible focus, respect reduced
motion, maintain readable contrast, and remain usable at 390, 768, and 1440
pixel viewport widths.

#### Scenario: Visitor uses keyboard or reduced motion
- **WHEN** a visitor navigates by keyboard or prefers reduced motion
- **THEN** all actions remain reachable with visible focus and nonessential motion is removed

### Requirement: Release exposes only the landing
The change SHALL release the static landing at
`motion.significanthobbies.com` without publishing internal application assets
or routes.

#### Scenario: Production hostname is opened
- **WHEN** a visitor loads `motion.significanthobbies.com`
- **THEN** the visitor receives the public landing and cannot navigate to the internal game, relay, or camera surfaces
