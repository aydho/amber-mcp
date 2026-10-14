import { getKey } from "./keystore.js";

const BASE = "https://api.amber.com.au/v1";

export class AmberError extends Error {}

export async function amberGet(
  path: string,
  query: Record<string, string | number | undefined> = {},
  opts: { auth?: boolean } = { auth: true },
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.auth !== false) {
    const key = await getKey();
    if (!key) throw new AmberError("No Amber API key set (or it expired). Call set_api_key first.");
    headers.Authorization = `Bearer ${key}`;
  }
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403)
      throw new AmberError("Amber rejected the API key (HTTP " + res.status + "). Call set_api_key with a valid key.");
    throw new AmberError(`Amber API error ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

/** Resolve a site id: use the given one, or the only site on the account. */
export async function resolveSite(siteId?: string): Promise<string> {
  if (siteId) return siteId;
  const sites = (await amberGet("/sites")) as { id: string }[];
  if (sites.length === 1) return sites[0].id;
  throw new AmberError(
    `site_id is required: account has ${sites.length} sites (${sites.map((s) => s.id).join(", ")}).`,
  );
}
