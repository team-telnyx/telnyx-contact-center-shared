// Shared by validation, preview and the voice runtime. No database or browser clock.
export class ScheduleError extends Error {
  constructor(message, code = "invalid_schedule", status = 400, details = {}) {
    super(message); this.name = "ScheduleError"; this.code = code; this.status = status; this.details = details;
  }
}
const fail = (message, code) => { throw new ScheduleError(message, code); };
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const defaultWeekly = () => WEEKDAYS.map((_, i) => ({ day: i + 1, periods: i < 5 ? [{ start: "09:00", end: "17:00" }] : [] }));
export const defaultScheduleConfig = () => ({ source: "custom", timeZone: "Europe/Warsaw", weekly: defaultWeekly(), useExceptions: false, calendarIds: [], timeSource: "node_entry", errorBranch: "false", resultVariable: "schedule_result" });
export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= "1900-01-01" && value <= "2199-12-31";
}
export function addDays(value, amount) { const d = new Date(`${value}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0, 10); }
export function validZone(value) {
  if (typeof value !== "string" || value.length > 100 || (!value.includes("/") && value !== "UTC")) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}
export function timeMinutes(value, allowEnd = false) {
  if (allowEnd && value === "24:00") return 1440;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail("Use a valid time in HH:mm format.");
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function text(value, label, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}
export function normalizePeriods(input, { overnight = true } = {}) {
  if (!Array.isArray(input) || input.length > 12) fail("Use at most 12 time periods per day.");
  const periods = input.map(p => {
    const start = timeMinutes(p?.start), end = timeMinutes(p?.end, true);
    if (start === end) fail("Start and end must differ. Use 00:00–24:00 for a full day.");
    if (!overnight && end < start) fail("Date exception hours must end on the same date. Add a separate exception for the next day.");
    return { start: p.start, end: p.end };
  });
  return periods.sort((a, b) => a.start.localeCompare(b.start));
}
export function normalizeSchedule(input) {
  if (!validZone(input?.timeZone)) fail("Choose a valid IANA time zone.");
  if (!Array.isArray(input.weekly) || input.weekly.length !== 7) fail("A schedule must define all seven weekdays.");
  const weekly = input.weekly.map(d => {
    if (!Number.isInteger(d?.day) || d.day < 1 || d.day > 7) fail("Weekdays must be numbered 1 through 7.");
    return { day: d.day, periods: normalizePeriods(d.periods) };
  }).sort((a, b) => a.day - b.day);
  if (new Set(weekly.map(d => d.day)).size !== 7) fail("Weekdays must not be repeated.");
  const intervals = [];
  for (const d of weekly) for (const p of d.periods) {
    const a = (d.day - 1) * 1440 + timeMinutes(p.start);
    let b = (d.day - 1) * 1440 + timeMinutes(p.end, true);
    if (b < a) b += 1440;
    intervals.push([a, Math.min(b, 10080)]);
    if (b > 10080) intervals.push([0, b - 10080]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < intervals.length; i++) if (intervals[i][0] < intervals[i - 1][1]) fail("Weekly periods overlap, including an overnight period from the previous day.");
  return { timeZone: input.timeZone, weekly };
}
function annualSegments(entry) {
  const a = entry.startDate.slice(5), b = entry.endDate.slice(5);
  return a <= b ? [[a, b]] : [[a, "12-31"], ["01-01", b]];
}
export function normalizeCalendar(input) {
  if (!validDate(input?.coverageStart) || !validDate(input?.coverageEnd) || input.coverageEnd < input.coverageStart) fail("Set the calendar coverage start and end dates.");
  if (new Date(input.coverageEnd) - new Date(input.coverageStart) > 366 * 5 * 86400000) fail("Calendar coverage may span at most five years.");
  if (!Array.isArray(input.entries) || input.entries.length > 1000) fail("A calendar may contain up to 1,000 exceptions.");
  const entries = input.entries.map((e, index) => {
    if (!validDate(e?.startDate) || !validDate(e?.endDate) || e.endDate < e.startDate) fail(`Exception ${index + 1}: invalid date range.`);
    if (!["once", "annual"].includes(e.repeat)) fail("Choose one-time or annual repetition.");
    if (e.repeat === "annual" && (new Date(e.endDate) - new Date(e.startDate) >= 366 * 86400000 || (e.endDate.slice(0, 4) !== e.startDate.slice(0, 4) && e.startDate.slice(5) <= e.endDate.slice(5)))) fail("An annual date range must be shorter than one year.");
    if (e.repeat === "once" && (e.startDate < input.coverageStart || e.endDate > input.coverageEnd)) fail(`Exception ${index + 1} is outside calendar coverage.`);
    if (!["closed", "open", "hours"].includes(e.availability)) fail("Choose closed, open or custom hours.");
    const periods = e.availability === "hours" ? normalizePeriods(e.periods, { overnight: false }) : [];
    if (e.availability === "hours" && !periods.length) fail("Custom hours need at least one period.");
    for (let i = 1; i < periods.length; i++) if (timeMinutes(periods[i].start) < timeMinutes(periods[i - 1].end, true)) fail("Exception hours overlap.");
    const entry = { id: text(e.id, "Exception ID", 100), name: text(e.name, "Exception name"), startDate: e.startDate, endDate: e.endDate, repeat: e.repeat, availability: e.availability, periods };
    if (e.source && typeof e.source === "object") entry.source = Object.fromEntries(["provider", "country", "region", "importedAt"].filter(k => typeof e.source[k] === "string").map(k => [k, e.source[k].slice(0, 200)]));
    return entry;
  });
  if (new Set(entries.map(e => e.id)).size !== entries.length) fail("Exception IDs must be unique.");
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j]; if (a.repeat !== b.repeat) continue;
    const overlap = a.repeat === "once" ? a.startDate <= b.endDate && b.startDate <= a.endDate : annualSegments(a).some(x => annualSegments(b).some(y => x[0] <= y[1] && y[0] <= x[1]));
    if (overlap) fail(`Conflicting exceptions: ${a.name} and ${b.name}. One-time exceptions may override annual entries; entries of equal priority must not overlap.`);
  }
  return { coverageStart: input.coverageStart, coverageEnd: input.coverageEnd, entries };
}
export function normalizeNodeConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Provide a schedule configuration object.");
  if (!["custom", "shared"].includes(input.source)) fail("Choose custom or shared working hours.");
  if (!["node_entry", "call_received"].includes(input.timeSource)) fail("Choose when to evaluate the schedule.");
  if (!["true", "false"].includes(input.errorBranch)) fail("Choose the routing branch for evaluation errors.");
  if (typeof input.useExceptions !== "boolean") fail("Specify whether to use exception calendars.");
  const resultVariable = input.resultVariable || "schedule_result";
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(resultVariable) || ["constructor", "prototype", "__proto__"].includes(resultVariable)) fail("Use a result variable starting with a letter, followed by letters, numbers or underscores.");
  const ids = input.calendarIds ?? [];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== "string" || !id || id.length > 100) || new Set(ids).size !== ids.length) fail("Select up to 20 distinct exception calendars in priority order.");
  if (input.useExceptions && !ids.length) fail("Select a calendar or turn off exception calendars.");
  return { source: input.source, ...(input.source === "shared" ? { scheduleId: text(input.scheduleId, "Shared schedule", 100) } : normalizeSchedule(input)), timeSource: input.timeSource, errorBranch: input.errorBranch, resultVariable, useExceptions: input.useExceptions, calendarIds: ids };
}
export function normalizeResource(input) {
  if (!["schedule", "calendar"].includes(input?.kind)) fail("Unknown schedule resource type.");
  return { kind: input.kind, name: text(input.name, "Name"), description: typeof input.description === "string" ? input.description.slice(0, 1000) : "", definition: input.kind === "schedule" ? normalizeSchedule(input.definition) : normalizeCalendar(input.definition) };
}
const formatters = new Map();
export function localParts(instant, timeZone) {
  const d = new Date(instant); if (!Number.isFinite(d.getTime())) fail("Invalid evaluation timestamp.");
  if (!formatters.has(timeZone)) {
    if (!validZone(timeZone)) fail("Invalid time zone.");
    if (formatters.size > 500) formatters.clear();
    formatters.set(timeZone, new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }));
  }
  const p = Object.fromEntries(formatters.get(timeZone).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, minute: Number(p.hour) * 60 + Number(p.minute), second: Number(p.second) };
}
// Enumerate offsets around the date. Gaps reject; folds require an explicit choice.
export function resolveLocalMoment(date, time, timeZone, disambiguation = "reject") {
  if (!validDate(date)) fail("Choose a valid test date."); timeMinutes(time);
  if (!validZone(timeZone)) fail("Choose a valid IANA time zone.");
  if (!["reject", "earlier", "later"].includes(disambiguation)) fail("Invalid daylight-saving disambiguation.");
  const wall = Date.parse(`${date}T${time}:00Z`), offsets = new Set();
  for (let h = -48; h <= 48; h += 6) {
    const sample = wall + h * 3600000, p = localParts(sample, timeZone);
    offsets.add(Date.parse(`${p.date}T${p.time}:${String(p.second).padStart(2, "0")}Z`) - sample);
  }
  const candidates = [...offsets].map(offset => wall - offset).filter(n => { const p = localParts(n, timeZone); return p.date === date && p.time === time; }).sort((a, b) => a - b).map(n => new Date(n).toISOString());
  if (!candidates.length) fail("This local time does not exist because the clocks move forward. Choose another time.", "nonexistent_local_time");
  if (candidates.length > 1 && disambiguation === "reject") throw new ScheduleError("This local time occurs twice. Choose the earlier or later occurrence.", "ambiguous_local_time", 400, { candidates });
  return candidates[disambiguation === "later" ? candidates.length - 1 : 0];
}
function matchingException(calendar, date) {
  const entries = calendar.definition.entries.filter(e => e.repeat === "once" ? e.startDate <= date && e.endDate >= date : annualSegments(e).some(([a, b]) => date.slice(5) >= a && date.slice(5) <= b));
  return entries.find(e => e.repeat === "once") || entries[0];
}
function dayPlan(schedule, calendars, date) {
  for (const calendar of calendars) {
    const { coverageStart, coverageEnd } = calendar.definition;
    if (date < coverageStart || date > coverageEnd) throw new ScheduleError(
      `Calendar ${calendar.name} has no verified coverage for ${date}. Available coverage: ${coverageStart} through ${coverageEnd}.`,
      "calendar_coverage_missing", 400,
      { calendarId: calendar.id, calendarName: calendar.name, date, coverageStart, coverageEnd },
    );
  }
  for (const calendar of calendars) {
    const exception = matchingException(calendar, date);
    if (exception) return { periods: exception.availability === "closed" ? [] : exception.availability === "open" ? [{ start: "00:00", end: "24:00" }] : exception.periods, reason: "exception", calendarId: calendar.id, calendarName: calendar.name, exceptionId: exception.id, exceptionName: exception.name };
  }
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
  return { periods: schedule.weekly.find(d => d.day === weekday).periods, reason: "weekly", weekday };
}
export function evaluateSchedule({ schedule, calendars = [], instant, versions = [] }) {
  const local = localParts(instant, schedule.timeZone), plan = dayPlan(schedule, calendars, local.date);
  let matched = plan.periods.some(p => { const a = timeMinutes(p.start), b = timeMinutes(p.end, true); return local.minute >= a && (b < a || local.minute < b); });
  let overnight = false;
  if (!matched && plan.reason === "weekly") {
    // Previous-day coverage is needed only if a weekly overnight period could spill.
    const previousDate = addDays(local.date, -1), previousWeekday = (new Date(`${previousDate}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
    const possible = schedule.weekly.find(d => d.day === previousWeekday).periods.some(p => timeMinutes(p.end, true) < timeMinutes(p.start) && local.minute < timeMinutes(p.end, true));
    if (possible) {
      const previous = dayPlan(schedule, calendars, previousDate);
      matched = previous.reason === "weekly" && previous.periods.some(p => timeMinutes(p.end, true) < timeMinutes(p.start) && local.minute < timeMinutes(p.end, true));
      overnight = matched;
    }
  }
  return { status: "ok", matched, branch: matched ? "true" : "false", evaluatedAt: new Date(instant).toISOString(), timeZone: schedule.timeZone, localDate: local.date, localTime: local.time, ...plan, overnight, versions };
}
