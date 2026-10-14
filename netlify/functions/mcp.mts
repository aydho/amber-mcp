import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "@netlify/functions";
import { buildServer } from "../../src/server.js";

export const config: Config = { path: "/mcp" };

function authorized(req: Request): boolean {
  const secret = process.env.MCP_SHARED_SECRET;
  if (!secret) return false;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async (req: Request): Promise<Response> => {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
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
