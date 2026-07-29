import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const landing = path.join(root, "landing");

const required = [
  "index.html",
  "404.html",
  "styles.css",
  "llms.txt",
  "index.md",
  "api/ai.json",
  "_redirects",
  "_headers",
  "robots.txt",
  "sitemap.xml",
  "assets/motion-logo.png",
];

await Promise.all(required.map((file) => stat(path.join(landing, file))));

const [html, css, llms, markdown, redirects, ai, sourceLogo, publicLogo] =
  await Promise.all([
    readFile(path.join(landing, "index.html"), "utf8"),
    readFile(path.join(landing, "styles.css"), "utf8"),
    readFile(path.join(landing, "llms.txt"), "utf8"),
    readFile(path.join(landing, "index.md"), "utf8"),
    readFile(path.join(landing, "_redirects"), "utf8"),
    readFile(path.join(landing, "api/ai.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "web/public/motion-logo.png")),
    readFile(path.join(landing, "assets/motion-logo.png")),
  ]);

assert.match(html, /<link rel="canonical" href="https:\/\/motion\.significanthobbies\.com\/"/);
assert.match(html, /Your body is the controller/);
assert.match(html, /this website is not the game/i);
assert.match(html, /Camera frames are not transmitted or stored/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /:focus-visible/);
assert.match(redirects, /^\/api\/ai \/api\/ai\.json 200/m);

for (const text of [html, llms, markdown, JSON.stringify(ai)]) {
  assert.doesNotMatch(text, /href=["']\/play|debug=1|camera=1|room=|127\.0\.0\.1|localhost/i);
}

assert.equal(ai.canonicalUrl, "https://motion.significanthobbies.com/");
assert.equal(ai.status.publiclyPlayable, false);
assert.equal(ai.privacy.cameraFramesTransmitted, false);
assert.equal(ai.privacy.publicSiteRequestsCamera, false);

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
assert.equal(digest(sourceLogo), digest(publicLogo), "public logo must remain unchanged");

console.log(`Motion landing: ${required.length} required files and public boundaries verified`);
