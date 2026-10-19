import { ScheduleError, validDate } from "./evaluator.mjs";

const BASE = "https://date.nager.at/api/v3";
async function read(path, fetcher) {
  let response;
  try { response = await fetcher(`${BASE}${path}`, { signal: AbortSignal.timeout(15000), headers: { Accept: "application/json" } }); }
  catch { throw new ScheduleError("Holiday provider unavailable. Retry or import a calendar file.", "holiday_provider_unavailable", 502); }
  if (!response.ok) throw new ScheduleError("The holiday provider could not supply this calendar.", "holiday_provider_error", 502);
  const body = await response.json();
  if (!Array.isArray(body)) throw new ScheduleError("Unexpected holiday provider response.", "holiday_provider_error", 502);
  return body;
}
export async function holidayCountries(fetcher = fetch) {
  return (await read("/AvailableCountries", fetcher)).filter(c => /^[A-Z]{2}$/.test(c.countryCode) && typeof c.name === "string").map(c => ({ code: c.countryCode, name: c.name }));
}
export async function importHolidays({ country, year, region = "" }, fetcher = fetch) {
  if (!/^[A-Z]{2}$/.test(country || "") || !Number.isInteger(year) || year < 2000 || year > 2100 || (region && !/^[A-Z0-9-]{2,12}$/.test(region))) throw new ScheduleError("Choose a country, year and optional region code.");
  const data = await read(`/PublicHolidays/${year}/${country}`, fetcher);
  const regions = [...new Set(data.flatMap(d => Array.isArray(d.counties) ? d.counties : []))].sort();
  if (region && !regions.includes(region)) throw new ScheduleError("This region is not available for the selected country and year.");
  const grouped = new Map();
  for (const d of data) {
    if (!validDate(d.date) || !d.date.startsWith(`${year}-`) || (d.types && !d.types.includes("Public"))) continue;
    if (!d.global && Array.isArray(d.counties) && d.counties.length && (!region || !d.counties.includes(region))) continue;
    const names = grouped.get(d.date) || [];
    names.push(String(d.localName || d.name || "Public holiday").slice(0, 120)); grouped.set(d.date, names);
  }
  if (!grouped.size) throw new ScheduleError("The provider returned no public holidays for this selection.", "empty_holiday_calendar", 422);
  return { regions, definition: { coverageStart: `${year}-01-01`, coverageEnd: `${year}-12-31`, entries: [...grouped].sort().map(([date, names]) => ({ id: `holiday-${country}-${region || "national"}-${date}`, name: [...new Set(names)].join(" / ").slice(0, 120), startDate: date, endDate: date, repeat: "once", availability: "closed", periods: [], source: { provider: "Nager.Date", country, region, importedAt: new Date().toISOString() } })) } };
}
