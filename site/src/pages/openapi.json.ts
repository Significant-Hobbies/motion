import { site } from "../site.config";

export const prerender = true;

const errorSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string", description: "Machine-readable error code" },
        message: { type: "string", description: "Human-readable error message" },
        path: { type: "string", description: "Request path that caused the error" },
      },
      required: ["code", "message"],
    },
  },
  required: ["error"],
};

const versionParam = {
  name: "Api-Version",
  in: "header",
  description: "API version. Current version is 1. Deprecated versions are announced via Sunset response headers.",
  schema: { type: "string", default: "1" },
};

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: errorSchema } },
});

export function GET() {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: `${site.name} public API`,
      version: "1.0.0",
      description: `${site.name} — ${site.tagline}. The public web API exposes read-only agent surfaces: the agent catalog, sitemap, llms.txt, and per-page markdown alternates. The API is versioned via the Api-Version header; the current version is 1. Breaking changes require a new version and are announced via Sunset response headers.`,
      contact: { name: site.name, url: site.url },
    },
    servers: [{ url: site.url }],
    tags: [{ name: "agent-surfaces", description: "Machine-readable public surfaces" }],
    paths: {
      "/api/ai": {
        get: {
          operationId: "getAgentCatalog",
          tags: ["agent-surfaces"],
          summary: "Agent catalog",
          description: "JSON inventory of public agent surfaces.",
          parameters: [versionParam],
          responses: {
            "200": {
              description: "Agent catalog",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      version: { type: "string" },
                      url: { type: "string", format: "uri" },
                      llms: { type: "string", format: "uri" },
                      sitemap: { type: "string", format: "uri" },
                      openapi: { type: "string", format: "uri" },
                      surfaces: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            url: { type: "string" },
                            md: { type: "string" },
                            kind: { type: "string" },
                          },
                          required: ["id", "url", "kind"],
                        },
                      },
                    },
                    required: ["name", "version", "url", "surfaces"],
                  },
                },
              },
            },
            "429": errorResponse("Rate limit exceeded"),
          },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "getLlmsTxt",
          tags: ["agent-surfaces"],
          summary: "llms.txt index",
          description: "Markdown index of agent surfaces and product context for LLM consumption.",
          parameters: [versionParam],
          responses: {
            "200": {
              description: "Markdown index",
              content: { "text/plain": { schema: { type: "string", description: "Markdown-formatted agent index" } } },
            },
          },
        },
      },
      "/sitemap.xml": {
        get: {
          operationId: "getSitemap",
          tags: ["agent-surfaces"],
          summary: "Sitemap",
          description: "XML sitemap listing all public pages.",
          parameters: [versionParam],
          responses: {
            "200": {
              description: "XML sitemap",
              content: { "application/xml": { schema: { type: "string", description: "XML sitemap document" } } },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApiSpec",
          tags: ["agent-surfaces"],
          summary: "OpenAPI specification",
          description: "This document — the OpenAPI 3.1 specification for the public API.",
          parameters: [versionParam],
          responses: {
            "200": {
              description: "OpenAPI 3.1 spec",
              content: { "application/json": { schema: { type: "object", description: "OpenAPI 3.1 specification document" } } },
            },
          },
        },
      },
    },
  };
  return new Response(JSON.stringify(spec, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
