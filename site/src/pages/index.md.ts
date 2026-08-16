import { links, site } from "../site.config";

export const prerender = true;

export function GET() {
  const lines = [
    `# ${site.name}`,
    "",
    `> ${site.tagline}`,
    "",
    site.summary,
    "",
    `Status: ${site.status}.`,
    "",
    "## Product areas",
    "",
    ...site.capabilities.map((item) => `- ${item}`),
    "",
    "## Important boundaries",
    "",
    ...site.boundaries.map((item) => `- ${item}`),
    "",
    "## Canonical links",
    "",
    ...Object.entries(links).map(([name, url]) => `- ${name}: ${url}`),
    "",
    `Last updated: ${site.lastUpdated}`,
    ""
  ];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
