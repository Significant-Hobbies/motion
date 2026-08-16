import { site } from "../site.config";

export const prerender = true;

export function GET() {
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
