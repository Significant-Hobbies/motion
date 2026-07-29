## ADDED Requirements

### Requirement: First viewport explains Motion
The landing SHALL state the primary audience, concrete outcome, product
mechanism, and one primary next action without requiring a scroll.

#### Scenario: Visitor opens the landing
- **WHEN** a visitor loads the public root page
- **THEN** the first viewport identifies Motion as body-controlled play driven by an iPhone and offers one clearly labelled action

### Requirement: Public demo uses the real game build
The site SHALL provide a browser demonstration assembled from the existing web
game output and SHALL label mouse or keyboard control separately from iPhone
body tracking.

#### Scenario: Visitor opens the browser demo
- **WHEN** a visitor follows the primary demonstration action
- **THEN** the existing game runs in browser debug mode without requiring a phone or implying that debug input is camera tracking

### Requirement: Landing does not change the iOS game contract
The landing build MUST leave the existing web workspace output semantics,
relative asset base, inline entry, pose protocol, and Swift bridge unchanged.

#### Scenario: Landing bundle is built
- **WHEN** the public deployment bundle is assembled
- **THEN** the web workspace is built through its existing command and copied unchanged beneath the landing output

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

### Requirement: Release remains separately approved
The change SHALL prepare deployable source without creating DNS, deploying a
Cloudflare surface, or changing production traffic.

#### Scenario: Implementation is merged
- **WHEN** the landing implementation reaches the main branch
- **THEN** no public hostname or production deployment changes solely because of the merge
