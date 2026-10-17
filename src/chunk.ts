import { AmberError } from "./amber.js";
import { localDay, localRange, roundMin, toLocal } from "./format.js";

type Row = Record<string, any>;

/**
 * Longest local-day window sent to Amber in one request, per endpoint.
 * Verified against the live API: both /usage and /prices accept endDate - startDate <= 7 (NEM days) and answer
 * 422 "Maximum 7 days" beyond that. A 7-local-day window spans at most 8 NEM days (DST widens the start by a day),
 * i.e. endDate - startDate = 7, so it always fits.
 */
export const USAGE_MAX_CHUNK_DAYS = 7;
export const PRICES_MAX_CHUNK_DAYS = 7;
/** Longest range (inclusive local days) a caller may request. */
export const MAX_RANGE_DAYS = 90;
export const DEFAULT_CONCURRENCY = 3;
export const MAX_RETRIES = 3;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;

const DAY_MS = 86_400_000;
const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
export const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);

/** Throws a clear error for invalid dates, end before start, or more than MAX_RANGE_DAYS days. Returns the inclusive day count. */
export function checkRange(start: string, end: string): number {
  if (!isDate(start) || !isDate(end)) throw new AmberError("start_date and end_date must be real calendar dates in YYYY-MM-DD format");
  const days = dayDiff(start, end) + 1;
  if (days < 1) throw new AmberError(`end_date (${end}) is before start_date (${start})`);
  if (days > MAX_RANGE_DAYS)
    throw new AmberError(`Range of ${days} days exceeds the ${MAX_RANGE_DAYS}-day maximum; request ${MAX_RANGE_DAYS} days or fewer per call`);
  return days;
}

/** Every local date from start to end inclusive. */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Split an inclusive local-date range into consecutive windows of at most maxDays local days. */
export function splitDates(start: string, end: string, maxDays: number): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (let s = start; s <= end; s = addDays(s, maxDays)) {
    const e = addDays(s, maxDays - 1);
    out.push({ start: s, end: e < end ? e : end });
  }
  return out;
}

export type Chunk = { start: string; end: string; range: ReturnType<typeof localRange> };

/** Local-date windows, each converted to local-midnight bounds and the NEM days Amber expects. */
export const planChunks = (start: string, end: string, tz: string, maxDays: number): Chunk[] =>
  splitDates(start, end, maxDays).map((w) => ({ ...w, range: localRange(w.start, w.end, tz) }));

/** Drop duplicate intervals, keeping the first seen, keyed on (channel, interval start). */
export function dedupeRows<T extends Row>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.channelType}|${r.channelIdentifier ?? ""}|${roundMin(String(r.startTime))}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type ChunkFailure = { start: string; end: string; error: string };

export interface FetchOpts {
  concurrency?: number;
  maxRetries?: number;
  /** Absolute epoch ms after which no new request or retry is started. */
  deadline?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Delay before retry number `attempt` (0-based): Retry-After if given, else exponential backoff with equal jitter. */
export function backoffMs(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(exp / 2 + (random() * exp) / 2);
}

/**
 * Fetch every chunk with bounded concurrency. 429s are retried (Retry-After, else jittered exponential backoff).
 * Chunks that fail, or that cannot start/finish before the deadline, are reported in `failed`; nothing is dropped silently.
 * If every chunk fails, the first error is thrown so a plain failure still looks like a failure.
 */
export async function fetchChunks(
  chunks: Chunk[],
  fetchOne: (c: Chunk, signal?: AbortSignal) => Promise<Row[]>,
  opts: FetchOpts = {},
): Promise<{ rows: Row[]; failed: ChunkFailure[] }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const deadline = opts.deadline ?? Infinity;
  const results: (Row[] | undefined)[] = new Array(chunks.length);
  const failures = new Map<number, ChunkFailure>();
  let firstError: unknown;
  let next = 0;

  const fail = (i: number, e: unknown, suffix = "") => {
    firstError ??= e;
    const msg = e instanceof Error ? e.message : String(e);
    failures.set(i, { start: chunks[i].start, end: chunks[i].end, error: msg + suffix });
  };

  async function worker() {
    while (next < chunks.length) {
      const i = next++;
      if (now() >= deadline) {
        fail(i, new AmberError("not fetched: time budget exhausted"));
        continue;
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const signal = deadline === Infinity ? undefined : AbortSignal.timeout(Math.max(1, deadline - now()));
          results[i] = await fetchOne(chunks[i], signal);
          break;
        } catch (e) {
          const status = (e as AmberError).status;
          if (status === 429 && attempt < maxRetries) {
            const wait = backoffMs(attempt, (e as AmberError).retryAfterMs, random);
            if (now() + wait >= deadline) {
              fail(i, e, " (retry would exceed the time budget)");
              break;
            }
            await sleep(wait);
            continue;
          }
          const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
          fail(i, timedOut ? new AmberError("not completed: time budget exhausted") : e, status === 429 ? ` (after ${maxRetries} retries)` : "");
          break;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, chunks.length)) }, worker));
  if (failures.size === chunks.length && firstError) throw firstError;
  return {
    rows: results.flatMap((r) => r ?? []),
    failed: [...failures.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f),
  };
}

/** Local dates in [start, end] that fall inside any failed range. */
export const failedDates = (failed: ChunkFailure[]) => new Set(failed.flatMap((f) => eachDate(f.start, f.end)));

export function failureWarning(failed: ChunkFailure[], total: number): string {
  const ranges = failed.map((f) => (f.start === f.end ? f.start : `${f.start} to ${f.end}`)).join(", ");
  return `${failed.length} of ${total} fetch window(s) failed (${ranges}); results below cover only the remaining dates. See failedRanges for the errors; retry those dates separately.`;
}

/** Local dates (in tz) that have at least one interval. */
export const datesWithData = (rows: Row[], tz: string) => new Set(rows.map((r) => localDay(toLocal(String(r.startTime), tz))));
