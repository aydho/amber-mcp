import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;

const secret = () => {
  const s = process.env.MCP_SHARED_SECRET;
  if (!s) throw new Error("MCP_SHARED_SECRET is not configured");
  return s;
};

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (data: string) => createHmac("sha256", "oauth:" + secret()).update(data).digest("base64url");

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Stateless signed token: base64url(json).hmac */
export function sign(payload: Record<string, unknown>, ttlS: number): string {
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlS }));
  return `${body}.${mac(body)}`;
}

export function verify(token: string, typ: string): Record<string, any> | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEq(sig, mac(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.typ === typ && p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

export const isSharedSecret = (given: string) => safeEq(given, secret());
export const validAccessToken = (t: string) => verify(t, "access") !== null;

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
    grant_types_supported: ["authorization_code", "refresh_token"],
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

/** Dynamic client registration; client_id is a signed copy of the redirect URIs so nothing is stored. */
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
  const client_id = sign({ typ: "client", uris }, 10 * 365 * 24 * 3600);
  return json(
    {
      client_id,
      client_name: body.client_name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function authorizeParams(p: URLSearchParams) {
  const client = verify(p.get("client_id") ?? "", "client");
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

export async function authorize(req: Request) {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const a = authorizeParams(url.searchParams);
    if (!a) return page("<p>Invalid authorization request.</p>", 400);
    return page(`<h2>Connect to Amber MCP</h2><p>Enter your MCP shared secret to approve this connection.</p>
<form method="post" action="/authorize${esc(url.search)}">
<input type="password" name="secret" autofocus required style="width:100%;padding:.5rem;margin:.5rem 0">
<button style="padding:.5rem 1rem">Approve</button></form>`);
  }
  const a = authorizeParams(url.searchParams);
  if (!a) return page("<p>Invalid authorization request.</p>", 400);
  const form = await req.formData();
  if (!isSharedSecret(String(form.get("secret") ?? ""))) return page("<p>Wrong secret. Go back and try again.</p>", 403);
  const code = sign(
    { typ: "code", client_id: a.client_id, redirect_uri: a.redirect_uri, cc: a.code_challenge },
    CODE_TTL_S,
  );
  const dest = new URL(a.redirect_uri);
  dest.searchParams.set("code", code);
  if (a.state) dest.searchParams.set("state", a.state);
  return Response.redirect(dest.toString(), 302);
}

const tokens = () => ({
  access_token: sign({ typ: "access" }, ACCESS_TTL_S),
  token_type: "Bearer",
  expires_in: ACCESS_TTL_S,
  refresh_token: sign({ typ: "refresh" }, REFRESH_TTL_S),
});

export async function token(req: Request) {
  const form = new URLSearchParams(await req.text());
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const c = verify(form.get("code") ?? "", "code");
    const verifier = form.get("code_verifier") ?? "";
    if (!c) return oauthError("invalid_grant", "Invalid or expired code");
    if (c.client_id !== form.get("client_id") || c.redirect_uri !== form.get("redirect_uri"))
      return oauthError("invalid_grant", "Client or redirect_uri mismatch");
    if (!safeEq(createHash("sha256").update(verifier).digest("base64url"), c.cc))
      return oauthError("invalid_grant", "PKCE verification failed");
    return json(tokens());
  }
  if (grant === "refresh_token") {
    if (!verify(form.get("refresh_token") ?? "", "refresh"))
      return oauthError("invalid_grant", "Invalid or expired refresh token");
    return json(tokens());
  }
  return oauthError("unsupported_grant_type");
}
