import assert from "node:assert/strict";
import { test } from "node:test";
import { USAGE_MAX_CHUNK_DAYS } from "../src/chunk.js";
import { parseTime } from "../src/format.js";
import { fetchWindowed, shapeUsage } from "../src/server.js";
import { err, fakeAmber, TZ, usageRows } from "./helpers.js";

type Shaped = Record<string, any>;
async function run(rows: Record<string, any>[], start: string, end: string, o: Partial<Parameters<typeof shapeUsage>[1]> = {}, hook?: Parameters<typeof fakeAmber>[1]) {
  const amber = fakeAmber(rows, hook);
  const w = await fetchWindowed(amber.get, "/sites/x/usage", {}, { start, end, tz: TZ, maxDays: USAGE_MAX_CHUNK_DAYS, startedAt: Date.now() });
  const out = shapeUsage(w.rows, { channel: "all", tz: TZ, aggregate: "daily", includeZero: false, totalsOnly: false, gapRun: 3, requested: { start, end }, failed: w.failed, chunkCount: w.chunkCount, ...o }) as Shaped;
  return { out, w, amber };
}

test("no interval is double counted at chunk boundaries; Amber's limit is never exceeded", async () => {
  const rows = usageRows("2026-06-01", "2026-06-21");
  const { out, w, amber } = await run(rows, "2026-06-01", "2026-06-21");
  assert.equal(amber.calls.length, 3);
  assert.equal(w.rows.length, 21 * 48);
  assert.equal(out.totals[0].intervals, 21 * 48);
  assert.equal(out.totals[0].kwh, 21 * 48 * 0.5);
  assert.equal(out.buckets.length, 21);
});

test("dedupe also removes genuinely duplicated rows returned by Amber", async () => {
  const rows = usageRows("2026-06-01", "2026-06-10");
  const { out } = await run([...rows, ...rows.slice(300, 330)], "2026-06-01", "2026-06-10");
  assert.equal(out.totals[0].intervals, 10 * 48);
});

test("DST days keep real interval counts (46 on 4 Oct, 50 on 5 Apr) across chunk boundaries", async () => {
  const oct = await run(usageRows("2026-09-28", "2026-10-11"), "2026-09-28", "2026-10-11");
  assert.equal(oct.out.buckets.find((b: Shaped) => b.start === "2026-10-04").intervals, 46);
  assert.equal(oct.out.buckets.find((b: Shaped) => b.start === "2026-10-05").intervals, 48);
  assert.equal(oct.out.buckets.length, 14);
  const apr = await run(usageRows("2026-03-30", "2026-04-12"), "2026-03-30", "2026-04-12");
  assert.equal(apr.out.buckets.find((b: Shaped) => b.start === "2026-04-05").intervals, 50);
  assert.equal(apr.out.buckets.length, 14);
});

test("a gap spanning a chunk boundary is reported as one gap", async () => {
  // chunks: 1-7 Jun | 8-14 Jun. Zero from 23:00 on the 7th to 01:00 on the 8th = 4 intervals
  const from = parseTime("2026-06-07T23:00", TZ), to = parseTime("2026-06-08T01:00", TZ);
  const rows = usageRows("2026-06-01", "2026-06-14", { zero: (t) => t >= from && t < to });
  const { out } = await run(rows, "2026-06-01", "2026-06-14", { totalsOnly: true });
  assert.equal(out.dataQuality.suspectedGaps.length, 1);
  assert.equal(out.dataQuality.suspectedGaps[0].intervals, 4);
  assert.equal(out.dataQuality.suspectedGaps[0].start, "2026-06-07T23:00:00+10:00");
  assert.equal(out.dataQuality.suspectedGaps[0].end, "2026-06-08T01:00:00+10:00");
});

test("missingDays and dataFrom when the range starts before the account's data", async () => {
  const { out } = await run(usageRows("2026-07-20", "2026-08-05"), "2026-07-16", "2026-08-05");
  assert.deepEqual(out.dataQuality.missingDays, ["2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"]);
  assert.equal(out.dataQuality.dataFrom, "2026-07-20");
  const full = await run(usageRows("2026-07-20", "2026-08-05"), "2026-07-20", "2026-08-05");
  assert.deepEqual(full.out.dataQuality.missingDays, []);
  const none = await run([], "2026-07-16", "2026-07-18");
  assert.equal(none.out.dataQuality.dataFrom, null);
  assert.equal(none.out.dataQuality.missingDays.length, 3);
});

test("429 on one chunk is retried and the result is complete", async () => {
  let thrown = false;
  const amber = fakeAmber(usageRows("2026-06-01", "2026-06-21"), (q) => {
    if (q.startDate === "2026-06-08" && !thrown) {
      thrown = true;
      throw err(429, 1);
    }
  });
  const w = await fetchWindowed(amber.get, "/x", {}, { start: "2026-06-01", end: "2026-06-21", tz: TZ, maxDays: 7, startedAt: Date.now() });
  assert.equal(w.rows.length, 21 * 48);
  assert.deepEqual(w.failed, []);
  assert.equal(amber.calls.length, 4);
});

test("a failed chunk yields failedRanges + warning, and its days are not called missing", async () => {
  const { out } = await run(usageRows("2026-06-01", "2026-06-21"), "2026-06-01", "2026-06-21", {}, (q) => {
    if (q.startDate === "2026-06-08") throw err(500);
  });
  assert.deepEqual(out.dataQuality.failedRanges, [{ start: "2026-06-08", end: "2026-06-14", error: "Amber API error 500" }]);
  assert.ok(out.dataQuality.warnings.some((w: string) => /1 of 3 fetch window\(s\) failed \(2026-06-08 to 2026-06-14\)/.test(w)));
  assert.deepEqual(out.dataQuality.missingDays, []);
  assert.equal(out.totals[0].intervals, 14 * 48);
});

test("channel filter, totals_only and include_zero apply to the merged set", async () => {
  const rows = [...usageRows("2026-06-01", "2026-06-14"), ...usageRows("2026-06-01", "2026-06-14", { channel: "feedIn" })];
  const g = await run(rows, "2026-06-01", "2026-06-14", { channel: "general", totalsOnly: true });
  assert.equal(g.out.totals.length, 1);
  assert.equal(g.out.totals[0].intervals, 14 * 48);
  assert.equal(g.out.buckets, undefined);
});

// Live check; needs a real key. AMBER_API_KEY=... npm test
test("integration: 20 Jul - 13 Oct 2026 daily", { skip: !process.env.AMBER_API_KEY }, async () => {
  const { amberClient } = await import("../src/amber.js");
  const { get, resolveSite } = amberClient(process.env.AMBER_API_KEY!);
  const id = await resolveSite();
  const run2 = async (start: string) => {
    const w = await fetchWindowed(get, `/sites/${id}/usage`, {}, { start, end: "2026-10-13", tz: TZ, maxDays: 7, startedAt: Date.now() });
    return shapeUsage(w.rows, { channel: "general", tz: TZ, aggregate: "daily", includeZero: false, totalsOnly: false, gapRun: 3, requested: { start, end: "2026-10-13" }, failed: w.failed }) as Shaped;
  };
  const a = await run2("2026-07-20");
  assert.equal(a.buckets.length, 86);
  assert.equal(a.totals[0].kwh, 3139.7);
  assert.equal(a.totals[0].costDollars, 784.18);
  assert.equal(a.buckets.find((b: Shaped) => b.start === "2026-10-04").intervals, 46);
  assert.deepEqual(a.dataQuality.missingDays, []);
  const b = await run2("2026-07-16");
  assert.deepEqual(b.dataQuality.missingDays, ["2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"]);
});
