const QUICK_RANGES = { "1d": 1, "7d": 7, "30d": 30 };

function toLocalDateTimeInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function quickCallHistoryDateRange(days, now = new Date()) {
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  from.setHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
  return { range: `${days}d`, from: toLocalDateTimeInput(from), to: toLocalDateTimeInput(to) };
}

export function toIsoDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function resolveCallHistoryDateRange(saved, now = new Date()) {
  if (Object.hasOwn(QUICK_RANGES, saved?.range)) {
    return quickCallHistoryDateRange(QUICK_RANGES[saved.range], now);
  }
  if (saved?.range === "custom") {
    return { range: "custom", from: saved.from || "", to: saved.to || "" };
  }
  if (typeof saved?.from === "string" && typeof saved?.to === "string" && toIsoDateTime(saved.from) && toIsoDateTime(saved.to)) {
    // Older versions saved absolute dates without the selected quick range.
    // Recognize whole calendar-day presets and anchor them to the current day.
    if (saved.from.endsWith("T00:00") && (saved.to.endsWith("T23:59") || saved.to.endsWith("T00:00"))) {
      const days = (Date.parse(saved.to.slice(0, 10)) - Date.parse(saved.from.slice(0, 10))) / 86_400_000 + (saved.to.endsWith("T23:59") ? 1 : 0);
      if (Object.hasOwn(QUICK_RANGES, `${days}d`)) return quickCallHistoryDateRange(days, now);
    }
    return { range: "custom", from: saved.from, to: saved.to };
  }
  return quickCallHistoryDateRange(1, now);
}
