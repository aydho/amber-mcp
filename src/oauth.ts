import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ACCESS_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;
const AMBER = "https://api.amber.com.au/v1";

const aesKey = () => {
  const s = process.env.KEY_ENCRYPTION_SECRET;
  if (!s) throw new Error("KEY_ENCRYPTION_SECRET is not configured");
  return createHash("sha256").update("amber-mcp:" + s).digest();
};

/** Encrypted + authenticated stateless token (AES-256-GCM). The Amber API key travels inside it. */
export function seal(payload: Record<string, unknown>, ttlS: number): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aesKey(), iv);
  const data = Buffer.concat([
    c.update(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlS })),
    c.final(),
  ]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64url");
}

export function open(token: string, typ: string): Record<string, any> | null {
  try {
    const buf = Buffer.from(token, "base64url");
    const d = createDecipheriv("aes-256-gcm", aesKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const p = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString());
    return p.typ === typ && p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

/** Amber API key and expiry (epoch seconds) from an OAuth access token, or null. */
export function parseAccessToken(t: string): { key: string; exp: number } | null {
  const p = open(t, "access");
  return p ? { key: p.k, exp: p.exp } : null;
}

export const keyFromAccessToken = (t: string): string | null => parseAccessToken(t)?.key ?? null;

export async function amberKeyValid(key: string): Promise<boolean> {
  try {
    const r = await fetch(AMBER + "/sites", { headers: { Authorization: `Bearer ${key}` } });
    return r.ok;
  } catch {
    return false;
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });

const oauthError = (error: string, description?: string, status = 400) =>
  json({ error, error_description: description }, status);

const origin = (req: Request) => new URL(req.url).origin;

export function protectedResourceMetadata(req: Request) {
  return json({
    resource: origin(req) + "/mcp",
    authorization_servers: [origin(req)],
    bearer_methods_supported: ["header"],
  });
}

export function authServerMetadata(req: Request) {
  const o = origin(req);
  return json({
    issuer: o,
    authorization_endpoint: o + "/authorize",
    token_endpoint: o + "/token",
    registration_endpoint: o + "/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

const redirectOk = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
};

/** Dynamic client registration; client_id is a sealed copy of the redirect URIs so nothing is stored. */
export async function register(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
  const uris: unknown = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && redirectOk(u)))
    return oauthError("invalid_redirect_uri", "redirect_uris must be https (or localhost) URLs");
  return json(
    {
      client_id: seal({ typ: "client", uris }, 10 * 365 * 24 * 3600),
      client_name: body.client_name,
      redirect_uris: uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function authorizeParams(p: URLSearchParams) {
  const client = open(p.get("client_id") ?? "", "client");
  const redirect_uri = p.get("redirect_uri") ?? "";
  if (!client || !client.uris.includes(redirect_uri)) return null;
  if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge"))
    return null;
  return {
    client_id: p.get("client_id")!,
    redirect_uri,
    code_challenge: p.get("code_challenge")!,
    state: p.get("state") ?? "",
  };
}

const page = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Amber MCP</title>
<body style="font-family:system-ui;max-width:26rem;margin:4rem auto;padding:0 1rem">${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );

const form = (search: string, error = "") => `<h2>Connect to Amber MCP</h2>${error}
<p>Enter your Amber API key. It is checked against Amber, then encrypted into a token that expires in 30 days. It is not stored on the server.</p>
<form method="post" action="/authorize${esc(search)}">
<input type="password" name="api_key" autofocus required style="width:100%;padding:.5rem;margin:.5rem 0">
<button style="padding:.5rem 1rem">Connect</button></form>`;

export async function authorize(req: Request) {
  const url = new URL(req.url);
  const a = authorizeParams(url.searchParams);
  if (!a) return page("<p>Invalid authorization request.</p>", 400);
  if (req.method === "GET") return page(form(url.search));

  const apiKey = String((await req.formData()).get("api_key") ?? "").trim();
  if (!apiKey || !(await amberKeyValid(apiKey)))
    return page(form(url.search, "<p style='color:#b00'>Amber rejected that API key.</p>"), 403);
  const code = seal(
    { typ: "code", client_id: a.client_id, redirect_uri: a.redirect_uri, cc: a.code_challenge, k: apiKey },
    CODE_TTL_S,
  );
  const dest = new URL(a.redirect_uri);
  dest.searchParams.set("code", code);
  if (a.state) dest.searchParams.set("state", a.state);
  return Response.redirect(dest.toString(), 302);
}

export async function token(req: Request) {
  const f = new URLSearchParams(await req.text());
  if (f.get("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type");
  const c = open(f.get("code") ?? "", "code");
  if (!c) return oauthError("invalid_grant", "Invalid or expired code");
  if (c.client_id !== f.get("client_id") || c.redirect_uri !== f.get("redirect_uri"))
    return oauthError("invalid_grant", "Client or redirect_uri mismatch");
  const challenge = Buffer.from(createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url"));
  const expected = Buffer.from(c.cc);
  if (challenge.length !== expected.length || !timingSafeEqual(challenge, expected))
    return oauthError("invalid_grant", "PKCE verification failed");
  return json({
    access_token: seal({ typ: "access", k: c.k }, ACCESS_TTL_S),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
  });
}
