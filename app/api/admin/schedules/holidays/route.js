import { withPermission } from "@/lib/authz/guard";
import { holidayCountries, importHolidays } from "@/lib/schedules/holidays.mjs";
import { scheduleResponse } from "@/lib/schedules/http.mjs";

export const GET = withPermission("schedules:import", async request => scheduleResponse(async () => {
  const q = new URL(request.url).searchParams;
  if (!q.has("country")) return { countries: await holidayCountries() };
  return importHolidays({ country: q.get("country"), year: Number(q.get("year")), region: q.get("region") || "" });
}));
