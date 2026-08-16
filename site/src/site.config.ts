export type Chapter = {
  name: string;
  title: string;
  copy: string;
  image: string;
  alt: string;
};

export type Faq = { question: string; answer: string };
export type LegalSection = { title: string; body: string };
export type LegalPage = { title: string; lede: string; sections: LegalSection[] };

export type SiteConfig = {
  name: string;
  url: string;
  tagline: string;
  headline: [string, string];
  lede: string;
  kicker: string;
  summary: string;
  status: string;
  platforms: string[];
  themeColor: string;
  mark: string;
  socialImage: string;
  tokens: {
    paper: string;
    field: string;
    ink: string;
    inkSoft: string;
    inkFaint: string;
    accent: string;
    accentDark: string;
    accentSoft: string;
    lanternA: string;
    lanternB: string;
    lanternC: string;
    blush: string;
    inkOnDark: string;
  };
  hero: { image: string; alt: string; caption: string };
  gallery: { src: string; alt: string }[];
  applicationCategory: string;
  availability: "unreleased" | "testflight" | "app-store";
  appStoreUrl?: string;
  appStoreId?: string;
  betaNote: string;
  tension: { statement: string; title: string; copy: string };
  chaptersKicker: string;
  chaptersTitle: string;
  chaptersLede: string;
  chapters: Chapter[];
  fit: { kicker: string; title: string; yes: string; no: string };
  privacy: { kicker: string; title: string; copy: string };
  faqs: Faq[];
  founder: { quote: string; credit: string; note: string };
  closingTitle: [string, string];
  footerFinePrint: string;
  capabilities: string[];
  boundaries: string[];
  lastUpdated: string;
  legal: {
    privacy: LegalPage;
    support: LegalPage;
    terms: LegalPage;
    accessibility: LegalPage;
    testflight: LegalPage & { testing: string; notIncluded: string };
  };
  requiredHomeCopy: string[];
  prohibitedClaims: string[];
};

/** Replace every field. This example is a compileable scaffold, not a product. */
export const site: SiteConfig = {
  name: "App",
  url: "https://app.example.com",
  tagline: "One clear job on an iPhone.",
  headline: ["One clear", "job."],
  lede: "A private iPhone app for one job you already do by hand.",
  kicker: "Private. On your iPhone.",
  summary: "A private, local-first iPhone app. Fill this summary with the product’s actual job.",
  status: "Invite-only TestFlight beta preparation",
  platforms: ["iPhone"],
  themeColor: "#f4e6d4",
  mark: "/images/brand/mark.png",
  socialImage: "/images/brand/social.png",
  tokens: {
    paper: "#fff6ea",
    field: "#f4e6d4",
    ink: "#3a2418",
    inkSoft: "#6a4a38",
    inkFaint: "rgba(58, 36, 24, 0.15)",
    accent: "#c46a4a",
    accentDark: "#9a3f2a",
    accentSoft: "#e8a06a",
    lanternA: "#c46a4a",
    lanternB: "#e8a06a",
    lanternC: "#e0b04a",
    blush: "#f4d9dd",
    inkOnDark: "#f4e6d4"
  },
  hero: {
    image: "/images/screens/home.png",
    alt: "The iPhone app’s home screen",
    caption: "The first screen a person sees."
  },
  gallery: [
    { src: "/images/screens/home.png", alt: "Home screen" }
  ],
  applicationCategory: "LifestyleApplication",
  availability: "unreleased",
  betaNote: "Invite-only iPhone testing. No account required.",
  tension: {
    statement: "Name the tension in one line.",
    title: "Say what this is not.",
    copy: "Describe the in-between the product lives in, without jargon."
  },
  chaptersKicker: "How it works",
  chaptersTitle: "Three spaces hold the story.",
  chaptersLede: "Replace these chapters with the product’s real surfaces.",
  chapters: [
    {
      name: "Home",
      title: "See it at a glance.",
      copy: "The home screen should be obvious in one look.",
      image: "/images/screens/home.png",
      alt: "Home screen"
    }
  ],
  fit: {
    kicker: "An honest fit",
    title: "Made for this. Not that.",
    yes: "Who it is for, in one sentence.",
    no: "Who it is not for, in one sentence."
  },
  privacy: {
    kicker: "Private by default",
    title: "Your notes stay yours.",
    copy: "Say where data lives. Name any iCloud use. Do not invent a server."
  },
  faqs: [
    {
      question: "Do I need an account?",
      answer: "No. Replace this answer with the product’s real one."
    }
  ],
  founder: {
    quote: "A short line only you would write.",
    credit: "— Your name, creator",
    note: "One sentence about why the app exists."
  },
  closingTitle: ["Keep it simple.", "Make it yours."],
  footerFinePrint: "An independent iPhone app. © 2026 Sarthak Agrawal.",
  capabilities: ["Home: the first screen"],
  boundaries: ["No product account", "No advertising SDK"],
  lastUpdated: "2026-08-17",
  legal: {
    privacy: {
      title: "Your data stays on your devices.",
      lede: "Plain-language privacy for the current iPhone build.",
      sections: [
        { title: "What the app stores", body: "Describe the on-device records." },
        { title: "What we collect", body: "The developer does not run an account server." },
        { title: "Effective date", body: "Last updated 17 August 2026." }
      ]
    },
    support: {
      title: "Support, without a maze.",
      lede: "The fastest way to report a problem.",
      sections: [
        { title: "Send feedback", body: "Use TestFlight’s Send Beta Feedback action." }
      ]
    },
    terms: {
      title: "Simple beta terms.",
      lede: "These terms apply to the invite-only TestFlight beta.",
      sections: [
        { title: "Beta software", body: "Features may change. Keep anything you cannot lose somewhere else." },
        { title: "Changes", body: "Last updated 17 August 2026." }
      ]
    },
    accessibility: {
      title: "Access is part of the experience.",
      lede: "Built with Apple’s native accessibility tools.",
      sections: [
        { title: "Current support", body: "VoiceOver, Dynamic Type, and Reduce Motion." }
      ]
    },
    testflight: {
      title: "The beta is taking shape.",
      lede: "We only link to Apple after the enrollment URL is verified.",
      testing: "Name the flows a tester should try.",
      notIncluded: "Name what is not in this beta.",
      sections: []
    }
  },
  requiredHomeCopy: ["One clear", "private", "TestFlight"],
  prohibitedClaims: []
};

export const links = {
  home: `${site.url}/`,
  privacy: `${site.url}/privacy/`,
  support: `${site.url}/support/`,
  terms: `${site.url}/terms/`,
  accessibility: `${site.url}/accessibility/`,
  testflight: `${site.url}/testflight/`
};
