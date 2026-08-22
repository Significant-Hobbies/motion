import { links, site } from "../site.config";

export const prerender = true;

export function GET() {
  const body = [
    `# ${site.name}`,
    `> ${site.summary}`,
    "",
    "## When to use this",
    "- Best fit: body-controlled games where an iPhone reads movement on-device and turns it into game input",
    "- Best fit: screen-mirroring phone gameplay to a larger display without uploading camera frames",
    "- Not a fit: cloud-based motion capture or remote pose processing",
    "- Not a fit: games that require transmitting or storing camera frames",
    "",
    "## Primary",
    `- [Product overview](${links.home}index.md): Canonical Markdown summary of ${site.name}.`,
    `- [Privacy](${links.privacy}): Current privacy policy.`,
    `- [Support](${links.support}): Support and feedback.`,
    `- [TestFlight](${links.testflight}): Current beta availability.`,
    "",
    "## Machine surfaces",
    `- [Agent catalog](${site.url}/api/ai)`,
    `- [OpenAPI spec](${site.url}/openapi.json)`,
    `- [Sitemap](${site.url}/sitemap.xml)`,
    `- [This index](${site.url}/llms.txt)`,
    "",
    "## Product boundaries",
    ...site.boundaries.map((item) => `- ${item}`),
    ""
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
