import { AmberError } from "./amber.js";

export const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE ?? "Australia/Melbourne";

export const STATE_TZ: Record<string, string> = {
  nsw: "Australia/Sydney",
  vic: "Australia/Melbourne",
  qld: "Australia/Brisbane",
  sa: "Australia/Adelaide",
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "longOffset",
      });
    } catch {
      throw new AmberError(`Unknown timezone "${tz}". Use an IANA name like Australia/Melbourne.`);
    }
    dtfCache.set(tz, f);
  }
  return f;
}

function parts(ms: number, tz: string): Record<string, string> & { off: string } {
  const o: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(ms)) o[p.type] = p.value;
  const off = (o.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  return { ...o, off } as Record<string, string> & { off: string };
}

/** Round to the nearest minute, which removes Amber's ":00:01" interval-start quirk. */
export const roundMin = (iso: string) => Math.round(Date.parse(iso) / 60_000) * 60_000;

/** ISO timestamp in the given zone with its real UTC offset (e.g. 2026-10-14T19:30:00+11:00). */
export function toLocal(iso: string, tz: string): string {
  const p = parts(roundMin(iso), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00${p.off}`;
}

export const localHour = (local: string) => local.slice(0, 13) + ":00:00" + local.slice(19);
export const localDay = (local: string) => local.slice(0, 10);

const offsetMs = (ms: number, tz: string) => {
  const p = parts(ms, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};

/** Parse an ISO time with offset/Z, a zone-less "YYYY-MM-DDTHH:mm" (in tz), or "HH:mm" (next occurrence in tz). */
export function parseTime(input: string, tz: string, now = Date.now()): number {
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(input) && !/^\d{1,2}:\d{2}$/.test(input)) {
    const t = Date.parse(input);
    if (!Number.isNaN(t)) return t;
  }
  const full = input.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  const hm = input.match(/^(\d{1,2}):(\d{2})$/);
  const toUtc = (y: number, mo: number, d: number, h: number, mi: number) => {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    let utc = guess - offsetMs(guess, tz);
    utc = guess - offsetMs(utc, tz);
    return utc;
  };
  if (full) return toUtc(+full[1], +full[2], +full[3], +full[4], +full[5]);
  if (hm) {
    const p = parts(now, tz);
    let t = toUtc(+p.year, +p.month, +p.day, +hm[1], +hm[2]);
    if (t <= now) t = toUtc(+p.year, +p.month, +p.day + 1, +hm[1], +hm[2]);
    return t;
  }
  throw new AmberError(`Can't parse time "${input}". Use ISO (with offset), "YYYY-MM-DDTHH:mm" (local) or "HH:mm".`);
}

export const round = (n: unknown, dp = 2): number | null =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null;

export function pick<T extends Record<string, unknown>>(row: T, fields: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out as Partial<T>;
}

export function checkTz(tz: string) {
  dtf(tz);
}

const NEM_OFFSET_MS = 10 * 3_600_000;
const nemDate = (ms: number) => new Date(ms + NEM_OFFSET_MS).toISOString().slice(0, 10);
const nextDay = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);

/**
 * Amber's startDate/endDate are NEM-time (fixed UTC+10) days. For a local-date range, return the NEM days to request
 * plus the exact local-midnight window [fromMs, toMs) to clip the response to.
 */
export function localRange(startDate: string, endDate: string, tz: string) {
  const fromMs = parseTime(`${startDate}T00:00`, tz);
  const toMs = parseTime(`${nextDay(endDate)}T00:00`, tz);
  return { fromMs, toMs, nemStart: nemDate(fromMs), nemEnd: nemDate(toMs - 1) };
}

export function clipToRange<T extends { startTime?: any }>(rows: T[], r: { fromMs: number; toMs: number }): T[] {
  return rows.filter((x) => {
    const t = roundMin(String(x.startTime));
    return t >= r.fromMs && t < r.toMs;
  });
}
