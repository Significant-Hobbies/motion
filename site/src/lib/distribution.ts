import { site } from "../site.config";

export function verifiedTestFlightUrl(): string | undefined {
  const url = import.meta.env.PUBLIC_TESTFLIGHT_URL?.trim();
  return url?.startsWith("https://testflight.apple.com/") ? url : undefined;
}

export function verifiedAppStoreUrl(): string | undefined {
  const url = site.appStoreUrl?.trim();
  return url?.startsWith("https://apps.apple.com/") ? url : undefined;
}

export function primaryCta(): { href: string; label: string; kind: "app-store" | "testflight" | "status" } {
  const store = verifiedAppStoreUrl();
  if (site.availability === "app-store" && store) {
    return { href: store, label: "View on the App Store", kind: "app-store" };
  }
  const beta = verifiedTestFlightUrl();
  if (beta) return { href: beta, label: "Join the TestFlight beta", kind: "testflight" };
  return { href: "/testflight/", label: "See TestFlight status", kind: "status" };
}

/** Official Apple badge only. Never invent a badge or host a knock-off. */
export const appStoreBadge = {
  src: "https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg",
  alt: "Download on the App Store"
};
