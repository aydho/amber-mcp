import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AmberError, amberClient, type AmberClient } from "./amber.js";
import { amberKeyValid } from "./oauth.js";
import {
  PRICES_MAX_CHUNK_DAYS,
  USAGE_MAX_CHUNK_DAYS,
  type ChunkFailure,
  checkRange,
  datesWithData,
  dedupeRows,
  eachDate,
  failedDates,
  failureWarning,
  fetchChunks,
  planChunks,
} from "./chunk.js";
import { DEFAULT_TZ, STATE_TZ, checkTz, clipToRange, localDay, localHour, parseTime, pick, round, toLocal } from "./format.js";

export const VERSION = "0.6.0";

export interface AuthContext {
  apiKey: string;
  method: "oauth" | "api_key";
  /** epoch ms; absent for raw API-key bearers */
  expiresAt?: number;
  /** channel types present on the account (general, controlledLoad, feedIn); used to tailor tool schemas */
  channels?: string[];
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const siteId = z.string().optional().describe("Amber site id; defaults to the only site on the account");
const timezone = z
  .string()
  .optional()
  .describe(`IANA timezone for returned times (default ${DEFAULT_TZ}); offsets reflect daylight saving`);
const detail = z
  .enum(["compact", "full"])
  .default("compact")
  .describe(
    "compact: key fields plus spikeStatus (only when not 'none') and Amber's forecast model values (forecastLow/Predicted/High); full: also spotPerKwh, descriptor, tariff period",
  );
const aggregate = z
  .enum(["none", "hourly", "daily"])
  .default("none")
  .describe("Collapse intervals into hourly or daily buckets (local time) to shrink the response. Buckets have a fixed shape, so fields (and detail) do not apply");

type AmberGet = AmberClient["get"];
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
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

const noFieldsWithAggregate = (fields: unknown, aggregate: string) => {
  if (fields !== undefined && aggregate !== "none")
    throw new AmberError('"fields" only applies when aggregate="none"; aggregated buckets have a fixed shape. Drop fields or set aggregate="none".');
};

const tzOf = (tz?: string, fallback = DEFAULT_TZ) => {
  const z = tz ?? fallback;
  checkTz(z);
  return z;
};

type Row = Record<string, any>;
const matches = (r: Row, ch: string) => ch === "all" || r.channelType === ch;
const byStart = (a: Row, b: Row) => String(a.startTime).localeCompare(String(b.startTime));
const kind = (t: string) => (t === "ActualInterval" ? "actual" : t === "CurrentInterval" ? "current" : "forecast");

const PRICE_FIELDS = ["start", "end", "channel", "type", "perKwh", "spotPerKwh", "renewables", "descriptor", "spikeStatus", "forecastLow", "forecastPredicted", "forecastHigh", "tariffPeriod"] as const;
const PRICE_DEFAULT = ["start", "end", "channel", "type", "perKwh", "renewables", "spikeStatus", "forecastLow", "forecastPredicted", "forecastHigh"];
const PRICE_FULL = [...PRICE_DEFAULT, "spotPerKwh", "descriptor", "tariffPeriod"];

function shapePrices(rows: Row[], o: { channel: string; tz: string; aggregate: string; detail: string; fields?: readonly string[] }) {
  const list = rows.filter((r) => matches(r, o.channel)).sort(byStart);
  if (o.aggregate === "none") {
    return list.map((r) => {
      const adv = r.advancedPrice ?? {};
      const row = {
        start: toLocal(r.startTime, o.tz),
        end: toLocal(r.endTime, o.tz),
        channel: r.channelType,
        type: kind(r.type),
        perKwh: round(r.perKwh),
        spotPerKwh: round(r.spotPerKwh),
        renewables: round(r.renewables, 1),
        descriptor: r.descriptor,
        spikeStatus: r.spikeStatus,
        forecastLow: round(adv.low),
        forecastPredicted: round(adv.predicted),
        forecastHigh: round(adv.high),
        tariffPeriod: r.tariffInformation?.period,
      };
      const out = pick(row, o.fields ?? (o.detail === "full" ? PRICE_FULL : PRICE_DEFAULT)) as Row;
      // sparse by default: drop spikeStatus "none" and absent forecast bands unless explicitly requested
      if (!o.fields) {
        if (out.spikeStatus === "none" || out.spikeStatus == null) delete out.spikeStatus;
        for (const k of ["forecastLow", "forecastPredicted", "forecastHigh"]) if (out[k] == null) delete out[k];
      }
      return out;
    });
  }
  const buckets = new Map<string, { channel: string; start: string; vals: number[]; ren: number[]; spikes: number }>();
  for (const r of list) {
    const local = toLocal(r.startTime, o.tz);
    const start = o.aggregate === "hourly" ? localHour(local) : localDay(local);
    const k = r.channelType + "|" + start;
    const b: { channel: string; start: string; vals: number[]; ren: number[]; spikes: number } = buckets.get(k) ?? { channel: r.channelType, start, vals: [], ren: [], spikes: 0 };
    if (r.spikeStatus && r.spikeStatus !== "none") b.spikes++;
    b.vals.push(r.perKwh);
    if (typeof r.renewables === "number") b.ren.push(r.renewables);
    buckets.set(k, b);
  }
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  return [...buckets.values()].map((b) => ({
    start: b.start,
    channel: b.channel,
    avgPerKwh: round(avg(b.vals)),
    minPerKwh: round(Math.min(...b.vals)),
    maxPerKwh: round(Math.max(...b.vals)),
    ...(b.ren.length ? { avgRenewables: round(avg(b.ren), 1) } : {}),
    ...(b.spikes ? { spikeIntervals: b.spikes } : {}),
    intervals: b.vals.length,
  }));
}

const USAGE_FIELDS = ["start", "end", "channel", "channelId", "kwh", "costCents", "perKwh", "quality", "renewables", "spotPerKwh"] as const;
const USAGE_DEFAULT = ["start", "end", "channel", "kwh", "costCents", "perKwh", "quality"];
/** Default minimum run of consecutive zero-kWh buy-channel intervals to flag as a suspected meter gap (3 x 30min = 1.5h). */
const GAP_RUN = 3;
const inPeak = (local: string) => {
  const h = +local.slice(11, 13);
  return h >= 16 && h < 21;
};

export function shapeUsage(
  rows: Row[],
  o: {
    channel: string;
    tz: string;
    aggregate: string;
    includeZero: boolean;
    totalsOnly: boolean;
    gapRun: number;
    fields?: readonly string[];
    /** requested local-date range, used for missingDays */
    requested: { start: string; end: string };
    failed?: ChunkFailure[];
    chunkCount?: number;
  },
) {
  const hasFeedIn = rows.some((r) => r.channelType === "feedIn");
  const list = rows.filter((r) => matches(r, o.channel)).sort(byStart);

  // totals + data quality per channel
  const perCh = new Map<string, Row[]>();
  for (const r of list) {
    const k = `${r.channelType}|${r.channelIdentifier}`;
    perCh.set(k, [...(perCh.get(k) ?? []), r]);
  }
  const totals: Row[] = [];
  const warnings: string[] = [];
  const gaps: Row[] = [];
  for (const [, rs] of perCh) {
    const kwh = rs.reduce((s, r) => s + (r.kwh ?? 0), 0);
    const cost = rs.reduce((s, r) => s + (r.cost ?? 0), 0);
    const zero = rs.filter((r) => !r.kwh).length;
    const estimated = rs.filter((r) => r.quality !== "billable").length;
    const name = `${rs[0].channelType} (${rs[0].channelIdentifier})`;
    totals.push({
      channel: rs[0].channelType,
      channelId: rs[0].channelIdentifier,
      kwh: round(kwh, 3),
      costCents: round(cost),
      costDollars: round(cost / 100),
      avgCentsPerKwh: kwh ? round(cost / kwh) : null,
      intervals: rs.length,
      zeroIntervals: zero,
      nonBillableIntervals: estimated,
    });
    if (zero === rs.length) warnings.push(`${name} recorded 0 kWh for every interval in this range.`);
    else if (rs[0].channelType === "general") {
      let run: Row[] = [];
      const flush = (trailing = false) => {
        if (run.length >= o.gapRun) {
          const start = toLocal(run[0].startTime, o.tz);
          gaps.push({
            channel: rs[0].channelType,
            start,
            end: toLocal(run[run.length - 1].endTime, o.tz),
            intervals: run.length,
            labelledBillable: run.filter((r) => r.quality === "billable").length,
            ...(inPeak(start) ? { duringEveningPeak: true } : {}),
            ...(trailing ? { atEndOfData: true } : {}),
            ...(hasFeedIn ? { possibleSolarSelfConsumption: true } : {}),
          });
        }
        run = [];
      };
      for (const r of rs) (r.kwh ? flush() : run.push(r));
      flush(true);
    }
  }
  if (gaps.length)
    warnings.push(
      `${gaps.length} run(s) of ${o.gapRun}+ consecutive zero-kWh intervals on the buy channel; this may be meter-data lag or a real gap even where quality says "billable". Treat those zeros as unverified.`,
    );
  const last = list.length ? toLocal(list[list.length - 1].endTime, o.tz) : null;
  const withData = datesWithData(rows, o.tz);
  const failed = o.failed ?? [];
  const failedSet = failedDates(failed);
  if (failed.length) warnings.push(failureWarning(failed, o.chunkCount ?? failed.length));
  const dataQuality = {
    dataThrough: last,
    dataFrom: [...withData].sort()[0] ?? null,
    missingDays: eachDate(o.requested.start, o.requested.end).filter((d) => !withData.has(d) && !failedSet.has(d)),
    suspectedGaps: gaps,
    warnings,
    ...(failed.length ? { failedRanges: failed } : {}),
  };

  const head = { timezone: o.tz, totals, dataQuality };
  if (o.totalsOnly) return head;

  const kept = o.includeZero ? list : list.filter((r) => r.kwh);
  const omitted = list.length - kept.length;
  if (o.aggregate === "none") {
    return {
      ...head,
      zeroRowsOmitted: omitted,
      rows: kept.map((r) =>
        pick(
          {
            start: toLocal(r.startTime, o.tz),
            end: toLocal(r.endTime, o.tz),
            channel: r.channelType,
            channelId: r.channelIdentifier,
            kwh: round(r.kwh, 3),
            costCents: round(r.cost),
            perKwh: round(r.perKwh),
            quality: r.quality,
            renewables: round(r.renewables, 1),
            spotPerKwh: round(r.spotPerKwh),
          },
          o.fields ?? USAGE_DEFAULT,
        ),
      ),
    };
  }
  const buckets = new Map<string, { channel: string; start: string; kwh: number; cost: number; n: number }>();
  for (const r of list) {
    const local = toLocal(r.startTime, o.tz);
    const start = o.aggregate === "hourly" ? localHour(local) : localDay(local);
    const k = `${r.channelType}|${start}`;
    const b = buckets.get(k) ?? { channel: r.channelType, start, kwh: 0, cost: 0, n: 0 };
    b.kwh += r.kwh ?? 0;
    b.cost += r.cost ?? 0;
    b.n++;
    buckets.set(k, b);
  }
  return {
    ...head,
    buckets: [...buckets.values()]
      .filter((b) => o.includeZero || b.kwh)
      .map((b) => ({
        start: b.start,
        channel: b.channel,
        kwh: round(b.kwh, 3),
        costCents: round(b.cost),
        avgCentsPerKwh: b.kwh ? round(b.cost / b.kwh) : null,
        intervals: b.n,
      })),
  };
}

/** Wall-clock budget for one tool call's Amber fetching; keeps us inside the Netlify function timeout (10s default). */
const FETCH_BUDGET_MS = Number(process.env.AMBER_FETCH_BUDGET_MS) || 8_000;

/**
 * Fetch an inclusive local-date range in chunks Amber accepts, clip each to its local-midnight window, and merge/dedupe.
 * Failed windows are returned, not thrown, unless every window failed.
 */
export async function fetchWindowed(
  amberGet: AmberGet,
  path: string,
  query: Record<string, string | number | undefined>,
  o: { start: string; end: string; tz: string; maxDays: number; startedAt: number },
) {
  const chunks = planChunks(o.start, o.end, o.tz, o.maxDays);
  const { rows, failed } = await fetchChunks(
    chunks,
    async (c, signal) => clipToRange((await amberGet(path, { ...query, startDate: c.range.nemStart, endDate: c.range.nemEnd }, { signal })) as Row[], c.range),
    { deadline: o.startedAt + FETCH_BUDGET_MS },
  );
  return { rows: dedupeRows(rows), failed, chunkCount: chunks.length };
}

export function buildServer(auth: AuthContext): McpServer {
  const { get: amberGet, resolveSite } = amberClient(auth.apiKey);
  const server = new McpServer(
    {
      name: "amber-mcp",
      title: "Amber Electric",
      version: VERSION,
      description: "Amber Electric prices, usage, renewables and cheapest-window finder for your Amber account.",
    },
    {
      instructions:
        "Tools for the Amber Electric API. Times are returned in local time (default Australia/Melbourne; set timezone to change). Prices are c/kWh. Prefer channel and aggregate=hourly|daily to keep responses small, and check get_usage's dataQuality block before trusting zero-usage periods.",
    },
  );
  const present = auth.channels?.length ? auth.channels : ["general", "controlledLoad", "feedIn"];
  const channel = z
    .enum(["all", ...present] as [string, ...string[]])
    .default("all")
    .describe(
      `Filter to one channel. Channels on your account: ${present.join(", ")} (general = buy${present.includes("controlledLoad") ? ", controlledLoad = off-peak" : ""}${present.includes("feedIn") ? ", feedIn = solar export" : ""})`,
    );
  const windowChannels = present.filter((c) => c !== "feedIn") as [string, ...string[]];

  server.registerTool(
    "get_auth_status",
    {
      description:
        "Read-only check of the connection: auth method, when the token expires and days remaining. Never reveals the API key.",
      inputSchema: { check_with_amber: z.boolean().default(false).describe("Also confirm Amber still accepts the key"), timezone },
    },
    wrap(async ({ check_with_amber, timezone: tzArg }) => {
      const tz = tzOf(tzArg);
      const out: Row = { serverVersion: VERSION, authenticated: true, method: auth.method };
      if (auth.expiresAt) {
        const days = (auth.expiresAt - Date.now()) / 86_400_000;
        out.timezone = tz;
        out.expiresAt = toLocal(new Date(auth.expiresAt).toISOString(), tz);
        out.expiresAtUtc = new Date(auth.expiresAt).toISOString();
        out.daysRemaining = round(days, 1);
        if (days < 3) out.warning = "Token expires soon; reconnect the connector to enter your key again.";
      } else out.expiresAt = null;
      if (check_with_amber) out.amberAcceptsKey = await amberKeyValid(auth.apiKey);
      return out;
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
        "Current price per channel on your site in c/kWh (2dp), optionally with forecast and past intervals. Includes spikeStatus (when not 'none') and Amber's forecast model values forecastLow/Predicted/High, which come from a separate model and need not bracket perKwh; detail=full adds spot price, descriptor and tariff period. Times are local with correct DST offsets.",
      inputSchema: {
        site_id: siteId,
        channel,
        next: z.number().int().min(0).max(2048).default(0).describe("Forecast intervals to include"),
        previous: z.number().int().min(0).max(2048).default(0).describe("Past intervals to include"),
        aggregate,
        detail,
        timezone,
        fields: z.array(z.enum(PRICE_FIELDS)).optional().describe(`Explicit field list; overrides detail. Only valid with aggregate="none" (default: ${PRICE_DEFAULT.join(", ")})`),
      },
    },
    wrap(async (a) => {
      noFieldsWithAggregate(a.fields, a.aggregate);
      const tz = tzOf(a.timezone);
      const id = await resolveSite(a.site_id);
      const rows = (await amberGet(`/sites/${id}/prices/current`, { next: a.next, previous: a.previous, resolution: 30 })) as Row[];
      return { timezone: tz, prices: shapePrices(rows, { channel: a.channel, tz, aggregate: a.aggregate, detail: a.detail, fields: a.fields }) };
    }),
  );

  server.registerTool(
    "get_price_history",
    {
      description: "Historical prices between two local dates (inclusive, aligned to local midnights), c/kWh. Maximum range is 90 days; ranges over 7 days are fetched in 7-day chunks and merged into one response (slower, so prefer aggregate=daily or hourly for long ranges). If a chunk fails, the rest is returned with failedRanges and a warning. Default is ~48 rows per channel per day; use channel and aggregate=hourly|daily to shrink it.",
      inputSchema: {
        site_id: siteId,
        start_date: date,
        end_date: date,
        resolution: z.union([z.literal(5), z.literal(30)]).default(30),
        channel,
        aggregate,
        detail,
        timezone,
        fields: z.array(z.enum(PRICE_FIELDS)).optional().describe(`Explicit field list; overrides detail. Only valid with aggregate="none" (default: ${PRICE_DEFAULT.join(", ")})`),
      },
    },
    wrap(async (a) => {
      noFieldsWithAggregate(a.fields, a.aggregate);
      const startedAt = Date.now();
      const tz = tzOf(a.timezone);
      checkRange(a.start_date, a.end_date);
      const id = await resolveSite(a.site_id);
      const { rows, failed, chunkCount } = await fetchWindowed(amberGet, `/sites/${id}/prices`, { resolution: a.resolution }, {
        start: a.start_date,
        end: a.end_date,
        tz,
        maxDays: PRICES_MAX_CHUNK_DAYS,
        startedAt,
      });
      return {
        timezone: tz,
        prices: shapePrices(rows, { channel: a.channel, tz, aggregate: a.aggregate, detail: a.detail, fields: a.fields }),
        ...(failed.length ? { warnings: [failureWarning(failed, chunkCount)], failedRanges: failed } : {}),
      };
    }),
  );

  server.registerTool(
    "get_usage",
    {
      description:
        "Consumption and cost between two local dates, inclusive; the range is aligned to local midnights. Maximum range is 90 days; ranges over 7 days are fetched in 7-day chunks and merged into one response (slower, so prefer totals_only or aggregate=daily for long ranges). Always returns per-channel totals (kWh, cost) and a data-quality section: dataFrom, dataThrough, missingDays (requested dates with no data), suspected meter gaps, and failedRanges if any chunk failed. Zero-kWh rows are dropped unless include_zero=true.",
      inputSchema: {
        site_id: siteId,
        start_date: date,
        end_date: date,
        channel,
        aggregate,
        gap_threshold_intervals: z.number().int().min(1).max(48).default(GAP_RUN).describe("Flag runs of at least this many consecutive zero-kWh buy-channel intervals as suspected meter gaps (30 min each)"),
        totals_only: z.boolean().default(false).describe("Return only totals and data quality, no rows"),
        include_zero: z.boolean().default(false).describe("Keep zero-kWh rows"),
        timezone,
        fields: z.array(z.enum(USAGE_FIELDS)).optional().describe(`Row fields; only valid with aggregate="none" (default: ${USAGE_DEFAULT.join(", ")})`),
      },
    },
    wrap(async (a) => {
      noFieldsWithAggregate(a.fields, a.aggregate);
      const startedAt = Date.now();
      const tz = tzOf(a.timezone);
      checkRange(a.start_date, a.end_date);
      const id = await resolveSite(a.site_id);
      const { rows, failed, chunkCount } = await fetchWindowed(amberGet, `/sites/${id}/usage`, {}, {
        start: a.start_date,
        end: a.end_date,
        tz,
        maxDays: USAGE_MAX_CHUNK_DAYS,
        startedAt,
      });
      return shapeUsage(rows, {
        channel: a.channel,
        tz,
        aggregate: a.aggregate,
        includeZero: a.include_zero,
        totalsOnly: a.totals_only,
        gapRun: a.gap_threshold_intervals,
        fields: a.fields,
        requested: { start: a.start_date, end: a.end_date },
        failed,
        chunkCount,
      });
    }),
  );

  server.registerTool(
    "get_renewables",
    {
      description: "Renewables percentage of the grid for a state (no API key needed): the current interval, plus past and forecast intervals via previous/next. Each row is typed actual/current/forecast; times are local to the state.",
      inputSchema: {
        state: z.enum(["nsw", "vic", "qld", "sa"]),
        next: z.number().int().min(0).max(2048).default(0),
        previous: z.number().int().min(0).max(2048).default(0),
        resolution: z.union([z.literal(5), z.literal(30)]).default(30),
        timezone,
      },
    },
    wrap(async (a) => {
      const tz = tzOf(a.timezone, STATE_TZ[a.state]);
      const rows = (await amberGet(
        `/state/${a.state}/renewables/current`,
        { next: a.next, previous: a.previous, resolution: a.resolution },
        { auth: false },
      )) as Row[];
      return {
        timezone: tz,
        renewables: rows.sort(byStart).map((r) => ({
          start: toLocal(r.startTime, tz),
          end: toLocal(r.endTime, tz),
          type: kind(r.type?.replace("Renewable", "Interval") ?? ""),
          renewables: round(r.renewables, 1),
        })),
      };
    }),
  );

  server.registerTool(
    "find_cheapest_window",
    {
      description:
        "Find the cheapest contiguous block(s) in the price forecast on a channel (e.g. EV charging, appliances). Returns the best window, next-best non-overlapping alternatives, and an optional cost estimate for a given load.",
      inputSchema: {
        site_id: siteId,
        duration_hours: z.number().min(0.5).max(24).describe("Length of the block (0.5h steps)"),
        within_hours: z.number().min(1).max(48).default(24).describe("Search horizon from now"),
        channel: z.enum(windowChannels.length ? windowChannels : ["general"]).default("general"),
        load_kw: z.number().positive().optional().describe("Average load in kW; adds an estimated cost"),
        finish_by: z
          .string()
          .optional()
          .describe('Window must end by this time: ISO with offset, local "YYYY-MM-DDTHH:mm", or "HH:mm" (next occurrence)'),
        alternatives: z.number().int().min(0).max(5).default(2).describe("Number of next-best non-overlapping windows"),
        include_intervals: z.boolean().default(false).describe("Include per-interval prices for each window"),
        timezone,
      },
    },
    wrap(async (a) => {
      const tz = tzOf(a.timezone);
      const id = await resolveSite(a.site_id);
      const need = Math.round(a.duration_hours * 2);
      let horizon = Math.round(a.within_hours * 2);
      const deadline = a.finish_by ? parseTime(a.finish_by, tz) : null;
      if (deadline !== null) {
        if (deadline <= Date.now()) throw new AmberError("finish_by is in the past");
        horizon = Math.min(horizon, Math.ceil((deadline - Date.now()) / 1_800_000) + 1);
      }
      if (need > horizon) throw new AmberError("duration_hours doesn't fit before within_hours / finish_by");
      const all = (await amberGet(`/sites/${id}/prices/current`, { next: horizon, resolution: 30 })) as Row[];
      const series = all
        .filter((p) => p.channelType === a.channel && p.type !== "ActualInterval")
        .filter((p) => deadline === null || roundMs(p.endTime) <= deadline)
        .sort(byStart);
      if (series.length < need) throw new AmberError(`Only ${series.length} usable forecast intervals available (need ${need})`);

      const cands: { i: number; avg: number }[] = [];
      for (let i = 0; i + need <= series.length; i++)
        cands.push({ i, avg: series.slice(i, i + need).reduce((s, p) => s + p.perKwh, 0) / need });
      cands.sort((x, y) => x.avg - y.avg || x.i - y.i);
      const chosen: typeof cands = [];
      for (const c of cands) {
        if (chosen.length > a.alternatives) break;
        if (chosen.every((d) => Math.abs(d.i - c.i) >= need)) chosen.push(c);
      }
      const hours = need / 2;
      const describe = (c: { i: number; avg: number }) => {
        const w = series.slice(c.i, c.i + need);
        return {
          start: toLocal(w[0].startTime, tz),
          end: toLocal(w[w.length - 1].endTime, tz),
          avgCentsPerKwh: round(c.avg),
          ...(a.load_kw ? { energyKwh: round(a.load_kw * hours, 2), estimatedCostDollars: round((c.avg * a.load_kw * hours) / 100) } : {}),
          ...(a.include_intervals ? { intervals: w.map((p) => ({ start: toLocal(p.startTime, tz), perKwh: round(p.perKwh) })) } : {}),
        };
      };
      return {
        timezone: tz,
        channel: a.channel,
        durationHours: hours,
        ...(deadline ? { finishBy: toLocal(new Date(deadline).toISOString(), tz) } : {}),
        best: describe(chosen[0]),
        alternatives: chosen.slice(1).map(describe),
        note: "Forecast prices can change; re-check close to the start time.",
      };
    }),
  );

  return server;
}

const roundMs = (iso: string) => Math.round(Date.parse(iso) / 60_000) * 60_000;
