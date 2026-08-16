export type Chapter = { name: string; title: string; copy: string; image: string; alt: string };
export type Faq = { question: string; answer: string };
export type LegalSection = { title: string; body: string };
export type LegalPage = { title: string; lede: string; sections: LegalSection[] };
export type SiteConfig = {
  name: string; url: string; tagline: string; headline: [string, string]; lede: string; kicker: string;
  summary: string; status: string; platforms: string[]; themeColor: string; mark: string; socialImage: string;
  tokens: { paper: string; field: string; ink: string; inkSoft: string; inkFaint: string; accent: string; accentDark: string; accentSoft: string; lanternA: string; lanternB: string; lanternC: string; blush: string; inkOnDark: string };
  colorScheme: "light" | "dark";
  hero: { image: string; alt: string; caption: string };
  gallery: { src: string; alt: string }[];
  applicationCategory: string;
  availability: "unreleased" | "testflight" | "app-store";
  appStoreUrl?: string; appStoreId?: string; betaNote: string;
  tension: { statement: string; title: string; copy: string };
  chaptersKicker: string; chaptersTitle: string; chaptersLede: string; chapters: Chapter[];
  fit: { kicker: string; title: string; yes: string; no: string };
  privacy: { kicker: string; title: string; copy: string };
  faqs: Faq[]; founder: { quote: string; credit: string; note: string }; closingTitle: [string, string];
  footerFinePrint: string; capabilities: string[]; boundaries: string[]; lastUpdated: string;
  legal: { privacy: LegalPage; support: LegalPage; terms: LegalPage; accessibility: LegalPage; testflight: LegalPage & { testing: string; notIncluded: string } };
  requiredHomeCopy: string[]; prohibitedClaims: string[];
};

export const site: SiteConfig = {
  name: "Motion",
  url: "https://motion.significanthobbies.com",
  tagline: "Your body is the controller.",
  headline: ["Move.", "Play."],
  lede: "An iPhone reads movement on-device and turns it into a game. Camera frames stay on the phone.",
  kicker: "A body-controlled game experiment.",
  summary: "Motion is an iPhone-hosted game experiment: on-device pose tracking turns movement into play and can mirror to a larger screen without uploading the camera stream.",
  status: "Game experiment. Not listed on the App Store.",
  platforms: ["iPhone"],
  themeColor: "#05070d",
  mark: "/images/brand/mark.png",
  socialImage: "/images/brand/social.png",
  tokens: {
    paper: "#05070d", field: "#0c111a", ink: "#e8eef7", inkSoft: "#8b97a8", inkFaint: "rgba(255,255,255,0.08)",
    accent: "#2dd4bf", accentDark: "#0f766e", accentSoft: "#5eead4", lanternA: "#2dd4bf", lanternB: "#38bdf8", lanternC: "#a78bfa",
    blush: "#111827", inkOnDark: "#e8eef7"
  },
  colorScheme: "dark",
  hero: { image: "/images/screens/motion-maker-clean.jpg", alt: "Motion Maker on iPhone", caption: "The phone is the camera, the tracker, and the game." },
  gallery: [
    { src: "/images/screens/motion-maker-clean.jpg", alt: "Motion Maker game on iPhone" }
  ],
  applicationCategory: "GameApplication",
  availability: "unreleased",
  betaNote: "Physical-device validation is still open. No App Store badge until a live listing exists.",
  tension: { statement: "Most motion games upload the room.", title: "The camera stays on the phone.", copy: "Vision runs on-device. The game can mirror to a TV. The stream does not go to us." },
  chaptersKicker: "One mechanic",
  chaptersTitle: "Move, and the game answers.",
  chaptersLede: "You should not need to understand pose estimation before it makes sense.",
  chapters: [
    { name: "Play", title: "The body is the controller.", copy: "The iPhone reads pose locally and drives the game. A keyboard debug path exists for the web renderer, not as the product.", image: "/images/screens/motion-maker-clean.jpg", alt: "Motion Maker" }
  ],
  fit: { kicker: "An honest fit", title: "An experiment, not a console.", yes: "Motion fits if you want to try a more physical way to play with a phone you already have.", no: "It is not a shipped App Store game, a wearable sensor kit, or a cloud camera service." },
  privacy: { kicker: "On the phone", title: "Frames do not leave the device.", copy: "Pose is extracted on-device. There is no Motion account and no uploaded camera stream." },
  faqs: [
    { question: "Does video go to a server?", answer: "No. Tracking runs on the iPhone. Mirroring uses the system screen, not our servers." },
    { question: "Is it on the App Store?", answer: "Not yet. This site will not show Apple’s App Store badge until a live apps.apple.com page exists." },
    { question: "Do I need extra hardware?", answer: "An iPhone. A TV is optional if you already know how to mirror a screen." }
  ],
  founder: { quote: "I wanted the room to stay in the room.", credit: "— Sarthak Agrawal, creator of Motion", note: "An independent experiment from Significant Hobbies." },
  closingTitle: ["Move.", "Keep the camera."],
  footerFinePrint: "A game experiment, not a console. © 2026 Sarthak Agrawal.",
  capabilities: ["On-device pose tracking", "Phone-hosted game", "Optional screen mirroring"],
  boundaries: ["No Motion account", "No uploaded camera stream", "Not listed on the App Store", "Physical-device validation still open"],
  lastUpdated: "2026-08-17",
  legal: {
    privacy: { title: "The camera stays on the phone.", lede: "Motion is a local-first game experiment.", sections: [
      { title: "What the app stores", body: "Game settings and local recordings you choose to save. Pose is computed on-device." },
      { title: "What we collect", body: "There is no Motion account and no camera upload." },
      { title: "Effective date", body: "Last updated 17 August 2026." }
    ]},
    support: { title: "Support, without a maze.", lede: "How to report a problem in the experiment.", sections: [
      { title: "Send feedback", body: "Use TestFlight’s Send Beta Feedback when a build exists. Describe the game, lighting, and what the body input did." }
    ]},
    terms: { title: "Simple beta terms.", lede: "Pre-release software for personal evaluation.", sections: [
      { title: "Beta software", body: "This is an experiment. Features may change." },
      { title: "Changes", body: "Last updated 17 August 2026." }
    ]},
    accessibility: { title: "Access is part of the experiment.", lede: "Body input is the point, so alternatives are documented honestly.", sections: [
      { title: "Current support", body: "A keyboard debug path exists for the web renderer. The intended product is body-controlled play on an iPhone." }
    ]},
    testflight: { title: "The beta is taking shape.", lede: "We only link to Apple after the enrollment URL is verified.", testing: "Launch a game, move, and confirm the playfield responds. Try screen mirroring if you already use it.", notIncluded: "An App Store listing and a finished multiplayer product are not in this experiment.", sections: [] }
  },
  requiredHomeCopy: [],
  prohibitedClaims: ["available on the app store"]
};
export const links = {
  home: `${site.url}/`, privacy: `${site.url}/privacy/`, support: `${site.url}/support/`,
  terms: `${site.url}/terms/`, accessibility: `${site.url}/accessibility/`, testflight: `${site.url}/testflight/`
};
