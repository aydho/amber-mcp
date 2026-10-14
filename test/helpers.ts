import { AmberError } from "../src/amber.js";
import { addDays } from "../src/chunk.js";
import { parseTime } from "../src/format.js";

export const TZ = "Australia/Melbourne";
const STEP = 30 * 60_000;

/** Synthetic 30-minute usage rows covering local dates [from, to], optionally zeroing some intervals. */
export function usageRows(from: string, to: string, opts: { tz?: string; zero?: (startMs: number) => boolean; channel?: string } = {}) {
  const tz = opts.tz ?? TZ;
  const rows: Record<string, any>[] = [];
  for (let t = parseTime(`${from}T00:00`, tz); t < parseTime(`${addDays(to, 1)}T00:00`, tz); t += STEP) {
    rows.push({
      channelType: opts.channel ?? "general",
      channelIdentifier: "E1",
      startTime: new Date(t).toISOString().replace(".000Z", "Z"),
      endTime: new Date(t + STEP - 1000).toISOString().replace(".000Z", "Z"),
      kwh: opts.zero?.(t) ? 0 : 0.5,
      cost: opts.zero?.(t) ? 0 : 12.5,
      perKwh: 25,
      quality: "billable",
    });
  }
  return rows;
}

const nemDay = (iso: string) => new Date(Date.parse(iso) + 10 * 3_600_000).toISOString().slice(0, 10);

/** Fake Amber GET: serves `rows` filtered by startDate/endDate (inclusive NEM days), 422 beyond 7 days like the real API. */
export function fakeAmber(rows: Record<string, any>[], hook?: (q: Record<string, any>, call: number) => void) {
  const calls: Record<string, any>[] = [];
  const get = async (_path: string, q: Record<string, any> = {}) => {
    calls.push(q);
    hook?.(q, calls.length);
    const span = (Date.parse(q.endDate) - Date.parse(q.startDate)) / 86_400_000;
    if (span > 7) {
      const e = new AmberError("Amber API error 422: Range requested is too large. Maximum 7 days.");
      e.status = 422;
      throw e;
    }
    return rows.filter((r) => nemDay(r.startTime) >= q.startDate && nemDay(r.startTime) <= q.endDate);
  };
  return { get: get as any, calls };
}

export const err = (status: number, retryAfterMs?: number) => {
  const e = new AmberError(`Amber API error ${status}`);
  e.status = status;
  e.retryAfterMs = retryAfterMs;
  return e;
};
