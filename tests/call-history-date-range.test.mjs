import assert from "node:assert/strict";
import test from "node:test";
import { quickCallHistoryDateRange, resolveCallHistoryDateRange, toIsoDateTime } from "../lib/contact-center/call-history-date-range.mjs";

const now = new Date(2026, 8, 13, 12, 30);

test("first entry defaults to the current local calendar day", () => {
  assert.deepEqual(resolveCallHistoryDateRange(null, now), {
    range: "1d", from: "2026-09-13T00:00", to: "2026-09-14T00:00",
  });
});

test("returning to each quick range recalculates dates instead of using old stored dates", () => {
  for (const [days, start] of [[1, "2026-09-13"], [7, "2026-09-07"], [30, "2026-08-15"]]) {
    const saved = quickCallHistoryDateRange(days, new Date(2026, 7, 10));
    assert.deepEqual(resolveCallHistoryDateRange(saved, now), {
      range: `${days}d`, from: `${start}T00:00`, to: "2026-09-14T00:00",
    });
  }
});

test("legacy full-day selections follow the current day and keep the correct quick button", () => {
  for (const days of [1, 7, 30]) {
    const { range: _, ...legacy } = quickCallHistoryDateRange(days, new Date(2026, 7, 10));
    assert.deepEqual(resolveCallHistoryDateRange(legacy, now), quickCallHistoryDateRange(days, now));
  }
});

test("custom dates remain absolute, including full-day custom ranges", () => {
  const saved = { range: "custom", from: "2026-08-10T00:00", to: "2026-08-10T23:59" };
  assert.deepEqual(resolveCallHistoryDateRange(saved, now), saved);
  const legacy = { from: "2026-08-10T09:30", to: "2026-08-11T16:15" };
  assert.deepEqual(resolveCallHistoryDateRange(legacy, now), { range: "custom", ...legacy });
});

test("invalid saved dates fall back to today", () => {
  for (const saved of [undefined, {}, { from: "invalid", to: "invalid" }, { from: 1, to: 2 }]) {
    assert.deepEqual(resolveCallHistoryDateRange(saved, now), quickCallHistoryDateRange(1, now));
  }
});

test("calendar ranges preserve local midnight across daylight saving changes", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Europe/Warsaw";
  try {
    const range = quickCallHistoryDateRange(7, new Date(2026, 2, 30, 12));
    assert.equal(range.from, "2026-03-24T00:00");
    assert.equal(range.to, "2026-03-31T00:00");
    assert.equal(toIsoDateTime(range.from), "2026-03-23T23:00:00.000Z");
    assert.equal(toIsoDateTime(range.to), "2026-03-30T22:00:00.000Z");
    const { range: _, ...legacy } = range;
    assert.equal(resolveCallHistoryDateRange(legacy, now).range, "7d");
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
