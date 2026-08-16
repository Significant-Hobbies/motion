import { links, site } from "../site.config";

export const prerender = true;

export function GET() {
  const body = [
    `# ${site.name}`,
    `> ${site.summary}`,
    "",
    "## Primary",
    `- [Product overview](${links.home}index.md): Canonical Markdown summary of ${site.name}.`,
    `- [Privacy](${links.privacy}): Current privacy policy.`,
    `- [Support](${links.support}): Support and feedback.`,
    `- [TestFlight](${links.testflight}): Current beta availability.`,
    "",
    "## Product boundaries",
    ...site.boundaries.map((item) => `- ${item}`),
    ""
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
