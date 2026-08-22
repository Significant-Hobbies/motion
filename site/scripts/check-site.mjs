import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "dist/index.html",
  "dist/privacy/index.html",
  "dist/support/index.html",
  "dist/terms/index.html",
  "dist/accessibility/index.html",
  "dist/testflight/index.html",
  "dist/index.md",
  "dist/llms.txt",
  "dist/api/ai",
  "dist/openapi.json",
  "dist/robots.txt",
  "dist/sitemap.xml"
];

await Promise.all(requiredFiles.map((file) => access(file)));

const home = await readFile("dist/index.html", "utf8");
const ai = JSON.parse(await readFile("dist/api/ai", "utf8"));
const name = ai.product?.name;
if (!name) throw new Error("AI product surface is missing a name.");
if (!home.includes(name)) throw new Error("Landing page does not name the product.");
if (!home.includes("See TestFlight status")) {
  throw new Error("Landing is missing the gated TestFlight fallback.");
}

for (const fragment of [
  `<link rel="canonical" href="${ai.url}/">`,
  'property="og:image"',
  'name="twitter:card" content="summary_large_image"'
]) {
  if (!home.includes(fragment)) throw new Error(`Landing metadata is missing: ${fragment}`);
}

if (home.includes("testflight.apple.com")) {
  throw new Error("A public TestFlight URL appeared without a verified build-time configuration.");
}

if (!home.includes("SoftwareApplication")) {
  throw new Error("Landing is missing SoftwareApplication structured data.");
}

if (!home.includes("id=\"look-inside\"") && !home.includes('id="look-inside"')) {
  throw new Error("Landing is missing the screenshot gallery.");
}

if (home.includes("Download on the App Store") && !home.includes("https://apps.apple.com/")) {
  throw new Error("App Store badge copy appeared without a verified apps.apple.com URL.");
}

const executableScripts = [...home.matchAll(/<script\b([^>]*)>/gi)].filter((match) => {
  const attrs = match[1] ?? "";
  return !/type=["']application\/ld\+json["']/i.test(attrs);
});
if (executableScripts.length !== 0) {
  throw new Error("The static landing unexpectedly ships client-side JavaScript.");
}

const localHrefs = [...home.matchAll(/href="(\/[^"]*)"/g)]
  .map((match) => match[1].split("#")[0])
  .filter((href, index, all) => href && all.indexOf(href) === index);

for (const href of localHrefs) {
  const outputPath = href === "/"
    ? "dist/index.html"
    : href.endsWith("/")
      ? `dist${href}index.html`
      : `dist${href}`;
  await access(outputPath);
}

const markdown = await readFile("dist/index.md", "utf8");
if (!markdown.startsWith(`# ${name}`)) {
  throw new Error("index.md does not start with the product name.");
}

console.log(`Checked ${requiredFiles.length} built public surfaces and ${localHrefs.length} internal links.`);
