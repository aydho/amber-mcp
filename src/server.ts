import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AmberError, amberGet, resolveSite } from "./amber.js";
import { clearKey, keyStatus, setKey } from "./keystore.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const siteId = z.string().optional().describe("Amber site id; defaults to the only site on the account");

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});
const wrap =
  <A>(fn: (a: A) => Promise<unknown>) =>
  async (a: A) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail(e);
    }
  };

export function buildServer(): McpServer {
  const server = new McpServer({ name: "amber-mcp", version: "0.1.0" });

  server.registerTool(
    "set_api_key",
    {
      description:
        "Set the Amber API key used by all other tools. Stored encrypted and expires after at most 60 minutes.",
      inputSchema: {
        api_key: z.string().min(8).describe("Amber API token from the Developers tab in the Amber app"),
        ttl_minutes: z.number().int().min(1).max(60).default(60).describe("Minutes to keep the key (max 60)"),
      },
    },
    wrap(async ({ api_key, ttl_minutes }) => {
      const expiresAt = await setKey(api_key.trim(), ttl_minutes);
      return { stored: true, expiresAt: new Date(expiresAt).toISOString() };
    }),
  );

  server.registerTool(
    "clear_api_key",
    { description: "Delete the stored Amber API key immediately." },
    wrap(async () => {
      await clearKey();
      return { cleared: true };
    }),
  );

  server.registerTool(
    "get_auth_status",
    { description: "Report whether an API key is set and how long until it expires. Never reveals the key." },
    wrap(async () => {
      const s = await keyStatus();
      return s.set ? { ...s, expiresAt: new Date(s.expiresAt!).toISOString() } : s;
    }),
  );

  server.registerTool(
    "list_sites",
    { description: "List the Amber sites (NMI, network, channels, status) linked to the account." },
    wrap(async () => amberGet("/sites")),
  );

  server.registerTool(
    "get_current_prices",
    {
      description:
        "Current electricity price per channel (general, controlledLoad, feedIn) in c/kWh, optionally with forecast and past intervals.",
      inputSchema: {
        site_id: siteId,
        next: z.number().int().min(0).max(2048).default(0).describe("Forecast intervals to include"),
        previous: z.number().int().min(0).max(2048).default(0).describe("Past intervals to include"),
      },
    },
    wrap(async ({ site_id, next, previous }) => {
      const id = await resolveSite(site_id);
      return amberGet(`/sites/${id}/prices/current`, { next, previous, resolution: 30 });
    }),
  );

  server.registerTool(
    "get_price_history",
    {
      description: "Prices between two dates (inclusive).",
      inputSchema: {
        site_id: siteId,
        start_date: date,
        end_date: date,
        resolution: z.union([z.literal(5), z.literal(30)]).default(30),
      },
    },
    wrap(async ({ site_id, start_date, end_date, resolution }) => {
      const id = await resolveSite(site_id);
      return amberGet(`/sites/${id}/prices`, { startDate: start_date, endDate: end_date, resolution });
    }),
  );

  server.registerTool(
    "get_usage",
    {
      description: "Consumption/generation and cost between two dates. Range is limited to 90 days.",
      inputSchema: { site_id: siteId, start_date: date, end_date: date },
    },
    wrap(async ({ site_id, start_date, end_date }) => {
      const days = (Date.parse(end_date) - Date.parse(start_date)) / 86_400_000;
      if (days < 0) throw new AmberError("end_date is before start_date");
      if (days > 90) throw new AmberError("Amber limits usage queries to 90 days");
      const id = await resolveSite(site_id);
      return amberGet(`/sites/${id}/usage`, { startDate: start_date, endDate: end_date });
    }),
  );

  server.registerTool(
    "get_renewables",
    {
      description: "Current renewables percentage of the grid for a state (no API key needed).",
      inputSchema: {
        state: z.enum(["nsw", "vic", "qld", "sa"]),
        next: z.number().int().min(0).max(2048).default(0),
        previous: z.number().int().min(0).max(2048).default(0),
        resolution: z.union([z.literal(5), z.literal(30)]).default(30),
      },
    },
    wrap(async ({ state, next, previous, resolution }) =>
      amberGet(`/state/${state}/renewables/current`, { next, previous, resolution }, { auth: false }),
    ),
  );

  server.registerTool(
    "find_cheapest_window",
    {
      description:
        "Find the cheapest contiguous block of time in the price forecast on a channel (e.g. for EV charging or appliances).",
      inputSchema: {
        site_id: siteId,
        duration_hours: z.number().min(0.5).max(24).describe("Length of the block, in 0.5h steps"),
        within_hours: z.number().min(1).max(48).default(24).describe("Search horizon from now"),
        channel: z.enum(["general", "controlledLoad"]).default("general"),
      },
    },
    wrap(async ({ site_id, duration_hours, within_hours, channel }) => {
      const id = await resolveSite(site_id);
      const need = Math.round(duration_hours * 2);
      const horizon = Math.round(within_hours * 2);
      if (need > horizon) throw new AmberError("duration_hours exceeds within_hours");
      const all = (await amberGet(`/sites/${id}/prices/current`, { next: horizon, resolution: 30 })) as {
        channelType: string;
        type: string;
        perKwh: number;
        startTime: string;
        endTime: string;
      }[];
      const series = all
        .filter((p) => p.channelType === channel && p.type !== "ActualInterval")
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      if (series.length < need) throw new AmberError(`Only ${series.length} forecast intervals available`);
      let best = { i: 0, avg: Infinity };
      for (let i = 0; i + need <= series.length; i++) {
        const avg = series.slice(i, i + need).reduce((s, p) => s + p.perKwh, 0) / need;
        if (avg < best.avg) best = { i, avg };
      }
      return {
        channel,
        start: series[best.i].startTime,
        end: series[best.i + need - 1].endTime,
        averageCentsPerKwh: Math.round(best.avg * 100) / 100,
        note: "Forecast prices can change.",
      };
    }),
  );

  return server;
}
