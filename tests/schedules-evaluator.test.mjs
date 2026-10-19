import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultWeekly, defaultScheduleConfig, normalizeCalendar, normalizeSchedule, normalizeNodeConfig, evaluateSchedule, resolveLocalMoment, localParts } from "../lib/schedules/evaluator.mjs";
import { resolveSchedule, runScheduleNode } from "../lib/schedules/runtime.mjs";
import { importHolidays } from "../lib/schedules/holidays.mjs";

const schedule = () => normalizeSchedule({ timeZone: "Europe/Warsaw", weekly: defaultWeekly() });
const entry = (patch = {}) => ({ id: "holiday", name: "Holiday", startDate: "2027-11-11", endDate: "2027-11-11", repeat: "once", availability: "closed", periods: [], ...patch });
const calendar = (entries = [entry()], patch = {}) => ({ id: "holidays", name: "Holidays", definition: normalizeCalendar({ coverageStart: "2027-01-01", coverageEnd: "2027-12-31", entries, ...patch }) });
const evaluate = (date, time, calendars = [], working = schedule()) => evaluateSchedule({ schedule: working, calendars, instant: resolveLocalMoment(date, time, working.timeZone) });

test("weekly boundaries are half open, including seconds", () => {
  for (const [time, expected] of [["08:59", false], ["09:00", true], ["16:59", true], ["17:00", false]]) assert.equal(evaluate("2027-11-10", time).matched, expected, time);
  assert.equal(evaluateSchedule({ schedule: schedule(), instant: "2027-11-10T15:59:59.999Z" }).matched, true);
  assert.equal(evaluate("2027-11-13", "10:00").matched, false);
});
test("split shifts, full days and closed weeks", () => {
  const s = schedule(); s.weekly[2].periods = [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:00" }];
  assert.equal(evaluate("2027-11-10", "12:00", [], s).matched, false);
  assert.equal(evaluate("2027-11-10", "13:00", [], s).matched, true);
  s.weekly[2].periods = [{ start: "00:00", end: "24:00" }];
  assert.equal(evaluate("2027-11-10", "23:59", [], s).matched, true);
  s.weekly.forEach(d => d.periods = []); assert.equal(evaluate("2027-11-10", "10:00", [], s).matched, false);
});
test("overnight periods cross weekdays and Sunday wraps to Monday", () => {
  const s = schedule(); s.weekly.forEach(d => d.periods = []); s.weekly[6].periods = [{ start: "22:00", end: "06:00" }]; normalizeSchedule(s);
  assert.equal(evaluate("2027-11-14", "22:00", [], s).matched, true);
  assert.equal(evaluate("2027-11-15", "05:59", [], s).overnight, true);
  assert.equal(evaluate("2027-11-15", "06:00", [], s).matched, false);
});
test("holidays replace the entire day, including overnight spill", () => {
  const s = schedule(); s.weekly[2].periods = [{ start: "22:00", end: "06:00" }];
  assert.equal(evaluate("2027-11-11", "01:00", [], s).matched, true);
  const decision = evaluate("2027-11-11", "01:00", [calendar()], s);
  assert.equal(decision.matched, false); assert.equal(decision.exceptionId, "holiday");
  const previousClosure = calendar([entry({ startDate: "2027-11-10", endDate: "2027-11-10" })]);
  assert.equal(evaluate("2027-11-11", "01:00", [previousClosure], s).matched, false);
});
test("priority, custom replacement hours, extra Saturday and forced open", () => {
  const company = calendar([entry({ id: "company", name: "Duty", availability: "hours", periods: [{ start: "10:00", end: "13:00" }] })]);
  assert.equal(evaluate("2027-11-11", "11:00", [company, calendar()]).matched, true);
  assert.equal(evaluate("2027-11-11", "11:00", [calendar(), company]).matched, false);
  assert.equal(evaluate("2027-11-11", "09:00", [company]).matched, false);
  assert.equal(evaluate("2027-11-11", "13:00", [company]).matched, false);
  assert.equal(evaluate("2027-11-13", "11:00", [calendar([entry({ startDate: "2027-11-13", endDate: "2027-11-13", availability: "open" })])]).matched, true);
});
test("one-time overrides annual; annual ranges cross year and leap day", () => {
  const c = calendar([entry({ repeat: "annual", startDate: "2026-12-24", endDate: "2027-01-02" }), entry({ id: "duty", startDate: "2027-01-01", endDate: "2027-01-01", availability: "open" })]);
  assert.equal(evaluate("2027-01-01", "11:00", [c]).matched, true);
  assert.equal(evaluate("2027-12-24", "11:00", [c]).matched, false);
  const leap = calendar([entry({ repeat: "annual", startDate: "2028-02-29", endDate: "2028-02-29" })], { coverageEnd: "2028-12-31" });
  assert.equal(evaluate("2028-02-29", "11:00", [leap]).reason, "exception");
  assert.equal(evaluate("2027-03-01", "11:00", [leap]).reason, "weekly");
});
test("missing coverage is an error, not an ordinary closed day", () => {
  for (const date of ["2026-12-25", "2028-01-03"]) {
    assert.throws(() => evaluate(date, "10:00", [calendar()]), error => {
      assert.equal(error.code, "calendar_coverage_missing");
      assert.deepEqual(error.details, { calendarId: "holidays", calendarName: "Holidays", date, coverageStart: "2027-01-01", coverageEnd: "2027-12-31" });
      assert.match(error.message, /2027-01-01 through 2027-12-31/);
      return true;
    });
  }
});
test("DST gaps reject, folds require selection and both real occurrences match", () => {
  assert.throws(() => resolveLocalMoment("2027-03-28", "02:30", "Europe/Warsaw"), e => e.code === "nonexistent_local_time");
  assert.throws(() => resolveLocalMoment("2027-10-31", "02:30", "Europe/Warsaw"), e => e.code === "ambiguous_local_time" && e.details.candidates.length === 2);
  const early = resolveLocalMoment("2027-10-31", "02:30", "Europe/Warsaw", "earlier"), late = resolveLocalMoment("2027-10-31", "02:30", "Europe/Warsaw", "later");
  assert.equal(Date.parse(late) - Date.parse(early), 3600000);
  const s = schedule(); s.weekly[6].periods = [{ start: "02:00", end: "03:00" }];
  for (const instant of [early, late]) assert.equal(evaluateSchedule({ schedule: s, instant }).matched, true);
  assert.equal(localParts("2027-01-01T02:00:00Z", "America/New_York").date, "2026-12-31");
  assert.throws(() => resolveLocalMoment("2027-03-14", "02:30", "America/New_York"), /does not exist/);
  assert.equal(resolveLocalMoment("2027-06-01", "10:00", "Asia/Kathmandu"), "2027-06-01T04:15:00.000Z");
});
test("validation rejects overlap, invalid fields, missing references and prototype variable names", () => {
  const s = schedule(); s.weekly[0].periods = [{ start: "22:00", end: "10:00" }]; assert.throws(() => normalizeSchedule(s), /overlap/);
  s.weekly[0].periods = [{ start: "09:00", end: "09:00" }]; assert.throws(() => normalizeSchedule(s), /must differ/);
  assert.throws(() => normalizeCalendar({ ...calendar().definition, entries: [entry(), entry({ id: "second" })] }), /Conflicting/);
  assert.throws(() => normalizeCalendar({ ...calendar().definition, entries: [entry({ startDate: "2027-02-29" })] }), /invalid date/);
  assert.throws(() => normalizeNodeConfig({ ...defaultScheduleConfig(), useExceptions: true }), /Select a calendar/);
  assert.throws(() => normalizeNodeConfig({ ...defaultScheduleConfig(), source: "shared" }), /Shared schedule/);
  assert.throws(() => normalizeNodeConfig({ ...defaultScheduleConfig(), resultVariable: "__proto__" }), /result variable/);
});
test("disabled exceptions cause no calendar reads", async () => {
  const seen = []; const config = { ...defaultScheduleConfig(), calendarIds: ["deleted"], useExceptions: false };
  const resolved = await resolveSchedule(config, { revisions: async ids => { seen.push(ids); return []; } });
  assert.deepEqual(seen, [[]]); assert.deepEqual(resolved.calendars, []);
});
test("runtime distinguishes arrival vs node entry and records explicit failure branch", async () => {
  const config = defaultScheduleConfig(), node = { id: "node", data: { config } };
  const context = { snapshot_at: "2027-11-10T07:00:00Z", received_at: "2027-11-10T15:59:00Z", node_configs: { node: config } };
  const store = { context: async () => context, revisions: async () => [], evaluation: async (...args) => args[4] };
  const opts = { store, now: () => "2027-11-10T16:01:00Z" };
  assert.equal((await runScheduleNode(node, "call", {}, { flowId: "flow" }, opts)).matched, false);
  config.timeSource = "call_received";
  assert.equal((await runScheduleNode(node, "call", {}, { flowId: "flow" }, opts)).matched, true);
  store.context = async () => { throw new Error("offline"); }; config.errorBranch = "true";
  const result = await runScheduleNode(node, "call", {}, { flowId: "flow" }, opts);
  assert.equal(result.status, "error"); assert.equal(result.matched, null); assert.equal(result.branch, "true");
});
test("holiday import keeps national scope, region selection, source and duplicate-date names", async () => {
  const data = [{ date: "2027-01-01", name: "New Year", global: true, types: ["Public"] }, { date: "2027-01-01", name: "Other name", global: true, types: ["Public"] }, { date: "2027-02-01", name: "Regional", global: false, counties: ["US-CA"], types: ["Public"] }, { date: "2027-02-02", name: "School", global: true, types: ["School"] }];
  const fetcher = async () => ({ ok: true, json: async () => data });
  assert.equal((await importHolidays({ country: "US", year: 2027 }, fetcher)).definition.entries.length, 1);
  const result = await importHolidays({ country: "US", year: 2027, region: "US-CA" }, fetcher);
  assert.equal(result.definition.entries.length, 2); assert.match(result.definition.entries[0].name, /Other name/);
  await assert.rejects(importHolidays({ country: "US", year: 2027, region: "US-XX" }, fetcher), /not available/);
  await assert.rejects(importHolidays({ country: "PL", year: 2027 }, async () => { throw new Error(); }), e => e.code === "holiday_provider_unavailable");
});

test('holiday import certifies only imported years in an empty draft and preserves manual annual overrides', async () => {
  const { mergeCalendarImport } = await import('../lib/schedules/calendar-import.mjs');
  const incoming={coverageStart:'2027-01-01',coverageEnd:'2027-12-31',entries:[{id:'holiday',name:'Christmas',startDate:'2027-12-25',endDate:'2027-12-25',repeat:'once',availability:'closed',periods:[]}]};
  const empty={coverageStart:'2026-01-01',coverageEnd:'2027-12-31',entries:[]};
  assert.equal(mergeCalendarImport(empty,incoming).coverageStart,'2027-01-01');
  const annual={id:'manual',name:'Open for Christmas',startDate:'2026-12-25',endDate:'2026-12-25',repeat:'annual',availability:'open',periods:[]};
  const result=mergeCalendarImport({...empty,entries:[annual]},incoming);
  assert.deepEqual(result.entries,[annual]);assert.equal(result.coverageStart,'2026-01-01');
  assert.deepEqual(mergeCalendarImport(result,incoming),result,'reimport is idempotent');
});

test('importing the missing adjacent year enables weekly hours and holidays in both years', async () => {
  const { mergeCalendarImport } = await import('../lib/schedules/calendar-import.mjs');
  const current = calendar([entry({ startDate: '2027-12-25', endDate: '2027-12-25' })]);
  const incoming = { coverageStart: '2026-01-01', coverageEnd: '2026-12-31', entries: [entry({ id: 'christmas-2026', startDate: '2026-12-25', endDate: '2026-12-25' })] };
  const merged = { ...current, definition: mergeCalendarImport(current.definition, incoming) };
  assert.equal(current.definition.coverageStart, '2027-01-01', 'Import does not mutate the published source');
  assert.equal(merged.definition.entries.length, 2);
  for (const date of ['2026-12-23', '2027-12-23']) {
    assert.equal(evaluate(date, '10:00', [merged]).branch, 'true');
    assert.equal(evaluate(date, '17:00', [merged]).branch, 'false');
  }
  for (const date of ['2026-12-25', '2027-12-25']) {
    const result = evaluate(date, '10:00', [merged]);
    assert.equal(result.branch, 'false'); assert.equal(result.reason, 'exception');
  }
});
