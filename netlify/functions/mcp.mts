import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "@netlify/functions";
import { amberKeyValid, keyFromAccessToken } from "../../src/oauth.js";
import { buildServer } from "../../src/server.js";

export const config: Config = { path: "/mcp" };

/** Amber API key from an OAuth access token, or a raw Amber key sent as the bearer (e.g. via mcp-remote). */
async function apiKeyFor(req: Request): Promise<string | null> {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return null;
  const fromToken = keyFromAccessToken(bearer);
  if (fromToken) return fromToken;
  return (await amberKeyValid(bearer)) ? bearer : null;
}

export default async (req: Request): Promise<Response> => {
  const apiKey = await apiKeyFor(req);
  if (!apiKey)
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${new URL(req.url).origin}/.well-known/oauth-protected-resource"`,
      },
    });
  if (req.method !== "POST")
    return new Response("Method not allowed (stateless server)", { status: 405, headers: { Allow: "POST" } });

  const server = buildServer(apiKey);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
};
