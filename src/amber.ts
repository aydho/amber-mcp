const BASE = "https://api.amber.com.au/v1";

export class AmberError extends Error {}

export type AmberClient = ReturnType<typeof amberClient>;

/** Amber API client bound to one user's API key (supplied per request, never stored). */
export function amberClient(apiKey: string) {
  async function get(
    path: string,
    query: Record<string, string | number | undefined> = {},
    opts: { auth?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.auth !== false) headers.Authorization = `Bearer ${apiKey}`;
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403)
        throw new AmberError(`Amber rejected the API key (HTTP ${res.status}). Reconnect the connector with a valid key.`);
      throw new AmberError(`Amber API error ${res.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  }

  /** Use the given site id, or the only site on the account. */
  async function resolveSite(siteId?: string): Promise<string> {
    if (siteId) return siteId;
    const sites = (await get("/sites")) as { id: string }[];
    if (sites.length === 1) return sites[0].id;
    throw new AmberError(
      `site_id is required: account has ${sites.length} sites (${sites.map((s) => s.id).join(", ")}).`,
    );
  }

  return { get, resolveSite };
}
