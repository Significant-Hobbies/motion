import { site } from "../site.config";

const pages = ["", "privacy/", "support/", "terms/", "accessibility/", "testflight/", "index.md", "llms.txt", "api/ai"];

export const prerender = true;

export function GET() {
  const urls = pages
    .map((path) => `  <url><loc>${site.url}/${path}</loc><lastmod>${site.lastUpdated}</lastmod></url>`)
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
