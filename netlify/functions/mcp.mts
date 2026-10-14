import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "@netlify/functions";
import { isSharedSecret, validAccessToken } from "../../src/oauth.js";
import { buildServer } from "../../src/server.js";

export const config: Config = { path: "/mcp" };

function authorized(req: Request): boolean {
  if (!process.env.MCP_SHARED_SECRET) return false;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return given !== "" && (isSharedSecret(given) || validAccessToken(given));
}

export default async (req: Request): Promise<Response> => {
  if (!authorized(req))
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${new URL(req.url).origin}/.well-known/oauth-protected-resource"`,
      },
    });
  if (req.method !== "POST")
    return new Response("Method not allowed (stateless server)", { status: 405, headers: { Allow: "POST" } });

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
};
