import type { Config } from "@netlify/functions";
import { authServerMetadata, authorize, protectedResourceMetadata, register, token } from "../../src/oauth.js";

export const config: Config = {
  path: [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/register",
    "/authorize",
    "/token",
  ],
};

export default async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  if (req.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  if (pathname.startsWith("/.well-known/oauth-protected-resource")) return protectedResourceMetadata(req);
  if (pathname === "/.well-known/oauth-authorization-server") return authServerMetadata(req);
  if (pathname === "/register" && req.method === "POST") return register(req);
  if (pathname === "/authorize" && ["GET", "POST"].includes(req.method)) return authorize(req);
  if (pathname === "/token" && req.method === "POST") return token(req);
  return new Response("Not found", { status: 404 });
};
