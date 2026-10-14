import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "@netlify/functions";
import { amberKeyValid, parseAccessToken } from "../../src/oauth.js";
import { buildServer, type AuthContext } from "../../src/server.js";

export const config: Config = { path: "/mcp" };

/** Amber API key (+ token expiry) from an OAuth access token, or a raw Amber key sent as the bearer (e.g. via mcp-remote). */
async function authFor(req: Request): Promise<AuthContext | null> {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return null;
  const t = parseAccessToken(bearer);
  if (t) return { apiKey: t.key, method: "oauth", expiresAt: t.exp * 1000 };
  return (await amberKeyValid(bearer)) ? { apiKey: bearer, method: "api_key" } : null;
}

/** Channel types on the account, so tools/list can show only channels that exist. Best-effort. */
async function channelsFor(apiKey: string): Promise<string[] | undefined> {
  try {
    const r = await fetch("https://api.amber.com.au/v1/sites", { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) return undefined;
    const sites = (await r.json()) as { channels?: { type: string }[] }[];
    const types = [...new Set(sites.flatMap((s) => (s.channels ?? []).map((c) => c.type)))];
    return types.length ? types : undefined;
  } catch {
    return undefined;
  }
}

async function isToolsList(req: Request): Promise<boolean> {
  if (req.method !== "POST") return false;
  try {
    const body = await req.clone().json();
    return (Array.isArray(body) ? body : [body]).some((m) => m?.method === "tools/list");
  } catch {
    return false;
  }
}

export default async (req: Request): Promise<Response> => {
  const auth = await authFor(req);
  if (!auth)
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${new URL(req.url).origin}/.well-known/oauth-protected-resource"`,
      },
    });
  if (req.method !== "POST")
    return new Response("Method not allowed (stateless server)", { status: 405, headers: { Allow: "POST" } });

  if (await isToolsList(req)) auth.channels = await channelsFor(auth.apiKey);
  const server = buildServer(auth);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
};
