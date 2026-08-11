# Motion App Store submission draft

Preparation only. Do not create, upload, publish, or submit an App Store Connect record from this repository.

## Identity

- Name: Motion
- Bundle ID: `com.motion.controller`
- SKU: `motion-ios-1`
- Version: `1.0.0`
- Build: `1`
- Primary language: English (U.S.)
- Primary category: Games
- Secondary category: Health & Fitness
- Copyright: `2026 Sarthak Agrawal`
- License: Apple's standard EULA
- Content rights: Motion owns or is licensed to use the bundled game, artwork, model, and audio-visual assets.

## Store copy

**Subtitle**
Move your body. Play.

**Promotional text**
Turn your iPhone camera into a private, on-device motion controller. Move, grab, dodge, and record the play you make.

**Description**
Your body is the controller.

Motion turns movement into play using your iPhone camera and on-device pose detection. Step into frame, follow the live framing guide, and start Motion Maker—a tactile playground where your hands grab, carry, and throw objects.

The complete primary game runs on your iPhone with no account and no server required. Mirror your screen to a larger display when you want the room to become the play space.

• Camera processing stays on device
• Motion Maker is bundled and works without a Mac
• Portrait full-body and landscape upper-body modes
• Front and wide-rear camera support
• Clap-to-start when you are standing away from the phone
• Optional ReplayKit recording saved directly to Photos
• Optional browser display for live normalized movement—never camera frames

Motion is an experimental movement game, not a fitness or medical service. Use it in a clear space and move within your own comfort and ability.

**Keywords**
movement,body,controller,game,pose,camera,play,motion,active,airplay

## URLs

- Support: `https://motion.significanthobbies.com`
- Marketing: `https://motion.significanthobbies.com`
- Privacy: `https://motion.significanthobbies.com/privacy`

The privacy source is prepared at `landing/privacy.html`; the live route must return HTTP 200 before submission.

## App privacy answers

- Tracking: No
- Data collected: No
- Camera frames and pose inference: processed on device
- Optional relay: transient normalized movement and room messages are forwarded to service a live session and are not retained
- Advertising, attribution, and third-party analytics: none
- IDFA: not used

## Age rating draft

- Made for Kids: No
- Gambling, contests, simulated gambling, loot boxes: None
- Sexual content, profanity, horror, drugs, alcohol, tobacco: None
- Medical or wellness topics: None
- User-generated content, messaging, unrestricted web access: None
- Cartoon/fantasy violence: Infrequent/Mild, because Motion Maker includes stylized sword-like play objects

Confirm the rating produced by App Store Connect's current questionnaire; do not manually claim a lower rating.

## Review notes

No login is required. Grant Camera access and stand where the on-screen framing guide can see the requested body area. The primary Motion Maker game is bundled in the app and does not need a server. Rotate to portrait for full-body controls or landscape for upper-body controls. Recording is optional and requests Photos add-only permission when used. The “Stream to website” setting is optional and is not required to review the primary experience.

Physical camera, pose accuracy, rotation, mirroring, ReplayKit output, and Photos saving require a real iPhone and remain device-verification items.

## Screenshots

- iPhone 6.9-inch portrait: `artifacts/app-store/iphone-6.9/motion-maker-clean.png` (`1206 × 2622`)
- iPad 13-inch portrait: `artifacts/app-store/ipad-13/motion-maker-clean.png` (`2064 × 2752`)
- Both files use Apple-accepted dimensions, contain no alpha channel, and were captured from the Release simulator build with the camera-free synthetic-pose harness
- App previews: omit for version 1.0
- Release: manual
