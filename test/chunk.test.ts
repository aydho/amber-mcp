import assert from "node:assert/strict";
import { test } from "node:test";
import { AmberError } from "../src/amber.js";
import { backoffMs, checkRange, dedupeRows, fetchChunks, planChunks, splitDates } from "../src/chunk.js";
import { err, TZ } from "./helpers.js";

const nemDiff = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

function assertPlan(start: string, end: string) {
  const chunks = planChunks(start, end, TZ, 7);
  assert.equal(chunks[0].start, start);
  assert.equal(chunks.at(-1)!.end, end);
  chunks.forEach((c, i) => {
    assert.ok(nemDiff(c.start, c.end) <= 6, "at most 7 local days");
    assert.ok(nemDiff(c.range.nemStart, c.range.nemEnd) <= 7, `NEM span within Amber's limit for ${c.start}`);
    if (i) {
      assert.equal(c.range.fromMs, chunks[i - 1].range.toMs, "local-midnight boundaries are contiguous");
      assert.equal(nemDiff(chunks[i - 1].end, c.start), 1);
    }
  });
  return chunks;
}

test("splitDates: exact multiples, remainders, single day", () => {
  assert.deepEqual(splitDates("2026-06-01", "2026-06-14", 7), [
    { start: "2026-06-01", end: "2026-06-07" },
    { start: "2026-06-08", end: "2026-06-14" },
  ]);
  assert.deepEqual(splitDates("2026-06-01", "2026-06-09", 7).at(-1), { start: "2026-06-08", end: "2026-06-09" });
  assert.equal(splitDates("2026-06-01", "2026-06-01", 7).length, 1);
  assert.equal(splitDates("2026-07-20", "2026-10-13", 7).length, 13);
  assert.equal(splitDates("2026-07-14", "2026-10-11", 7).length, 13); // 90 days
});

test("chunk boundaries across the October DST start (4 Oct 2026, 23h day)", () => {
  const chunks = assertPlan("2026-09-28", "2026-10-11");
  assert.deepEqual(chunks.map((c) => c.start), ["2026-09-28", "2026-10-05"]);
  const dstChunk = planChunks("2026-10-04", "2026-10-04", TZ, 7)[0];
  assert.equal((dstChunk.range.toMs - dstChunk.range.fromMs) / 3_600_000, 23);
  // a window that contains the change day is widened by a NEM day at the start, but never beyond Amber's limit
  const w = planChunks("2026-10-01", "2026-10-07", TZ, 7)[0];
  assert.equal(nemDiff(w.range.nemStart, w.range.nemEnd), 6);
  assertPlan("2026-10-01", "2026-12-29");
});

test("chunk boundaries across the April DST end (5 Apr 2026, 25h day)", () => {
  assertPlan("2026-03-30", "2026-04-12");
  const d = planChunks("2026-04-05", "2026-04-05", TZ, 7)[0];
  assert.equal((d.range.toMs - d.range.fromMs) / 3_600_000, 25);
  assertPlan("2026-02-01", "2026-04-30");
});

test("post-DST-start window sits exactly at Amber's limit (7 local days = 7 NEM-day span)", () => {
  const w = planChunks("2026-10-05", "2026-10-11", TZ, 7)[0];
  assert.equal(nemDiff(w.range.nemStart, w.range.nemEnd), 7);
});

test("checkRange validation", () => {
  assert.equal(checkRange("2026-07-20", "2026-10-13"), 86);
  assert.equal(checkRange("2026-07-14", "2026-10-11"), 90);
  assert.throws(() => checkRange("2026-07-13", "2026-10-11"), /91 days exceeds the 90-day maximum/);
  assert.throws(() => checkRange("2026-10-02", "2026-10-01"), /end_date \(2026-10-01\) is before start_date/);
  assert.throws(() => checkRange("2026-02-30", "2026-03-01"), /real calendar dates/);
});

test("dedupeRows on (channel, interval start), tolerant of :00:01 quirk", () => {
  const r = (ch: string, t: string) => ({ channelType: ch, channelIdentifier: "E1", startTime: t });
  const out = dedupeRows([r("general", "2026-10-01T00:00:01Z"), r("general", "2026-10-01T00:00:00Z"), r("controlledLoad", "2026-10-01T00:00:00Z"), r("general", "2026-10-01T00:30:00Z")]);
  assert.equal(out.length, 3);
});

test("backoff: Retry-After wins; otherwise exponential with jitter", () => {
  assert.equal(backoffMs(2, 1234, () => 0.5), 1234);
  assert.equal(backoffMs(0, undefined, () => 0), 250);
  assert.equal(backoffMs(0, undefined, () => 1), 500);
  assert.equal(backoffMs(1, undefined, () => 1), 1000);
  assert.equal(backoffMs(10, undefined, () => 1), 8000);
});

const chunks = planChunks("2026-06-01", "2026-06-21", TZ, 7); // 3 chunks

test("429 retries honour Retry-After, then succeed", async () => {
  const sleeps: number[] = [];
  let n = 0;
  const { rows, failed } = await fetchChunks(chunks, async (c) => {
    if (c.start === "2026-06-08" && n++ < 2) throw err(429, 1500);
    return [{ id: c.start }];
  }, { sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(sleeps, [1500, 1500]);
  assert.equal(rows.length, 3);
  assert.deepEqual(failed, []);
});

test("429 without Retry-After uses jittered exponential backoff; gives up after 3 retries", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const { failed } = await fetchChunks(chunks, async (c) => {
    if (c.start === "2026-06-08") {
      calls++;
      throw err(429);
    }
    return [{}];
  }, { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [375, 750, 1500]);
  assert.deepEqual(failed.map((f) => [f.start, f.end]), [["2026-06-08", "2026-06-14"]]);
  assert.match(failed[0].error, /429.*after 3 retries/);
});

test("a failed chunk is reported, others kept; all-failed throws", async () => {
  const { rows, failed } = await fetchChunks(chunks, async (c) => {
    if (c.start === "2026-06-15") throw err(500);
    return [{ id: c.start }];
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(failed, [{ start: "2026-06-15", end: "2026-06-21", error: "Amber API error 500" }]);
  await assert.rejects(fetchChunks(chunks, async () => { throw err(500); }), /500/);
});

test("concurrency is bounded", async () => {
  const many = planChunks("2026-06-01", "2026-08-30", TZ, 7);
  let live = 0, peak = 0;
  await fetchChunks(many, async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return [];
  }, { concurrency: 3 });
  assert.equal(peak, 3);
});

test("chunks not started before the deadline are reported, not dropped", async () => {
  let t = 0;
  const { rows, failed } = await fetchChunks(chunks, async () => { t += 600; return [{}]; }, { concurrency: 1, deadline: 1000, now: () => t });
  assert.equal(rows.length, 2);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /time budget/);
});

test("Retry-After longer than the remaining budget fails fast instead of sleeping", async () => {
  const { failed } = await fetchChunks(chunks.slice(0, 2), async (c) => {
    if (c.start === "2026-06-01") throw err(429, 60_000);
    return [{}];
  }, { deadline: 5000, now: () => 0, sleep: async () => assert.fail("should not sleep") });
  assert.match(failed[0].error, /exceed the time budget/);
});

test("non-AmberError failures are reported with their message", async () => {
  const { failed } = await fetchChunks(chunks, async (c) => { if (c.start === "2026-06-01") throw new TypeError("fetch failed"); return [{}]; });
  assert.equal(failed[0].error, "fetch failed");
  assert.ok(!(failed[0] instanceof AmberError));
});
