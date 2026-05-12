import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundSettings, requireOutboundSupervisor, safeJson, usernameFor } from "@/lib/outbound-dialer/api";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DEFAULT_CALLABLE_DAYS = ["mon", "tue", "wed", "thu", "fri"];

function normalizeCallableDays(settings = {}) {
  const days = settings.callable_days || settings.callableDays || DEFAULT_CALLABLE_DAYS;
  const normalized = (Array.isArray(days) ? days : [])
    .map((day) => String(day || "").trim().toLowerCase())
    .filter((day, idx, list) => WEEKDAYS.includes(day) && list.indexOf(day) === idx);
  return normalized.length ? normalized : DEFAULT_CALLABLE_DAYS;
}

function normalizeSettings(body = {}) {
  const settings = safeJson(body.settings || body, {});
  const countries = settings.supported_countries || settings.supportedCountries || [];
  const callable = settings.callable_window || settings.callableWindow || {};
  return {
    max_calls_per_agent: Math.max(1, Math.min(100, Number.parseInt(settings.max_calls_per_agent ?? settings.maxCallsPerAgent, 10) || 1)),
    max_lines: Math.max(1, Math.min(10000, Number.parseInt(settings.max_lines ?? settings.maxLines, 10) || 10)),
    max_line_utilization_percent: Math.max(1, Math.min(100, Number.parseInt(settings.max_line_utilization_percent ?? settings.maxLineUtilizationPercent, 10) || 90)),
    max_cps: Math.max(1, Math.min(1000, Number.parseInt(settings.max_cps ?? settings.maxCps, 10) || 50)),
    compliance_abandon_threshold_seconds: Math.max(0, Math.min(300, Number.parseInt(settings.compliance_abandon_threshold_seconds ?? settings.complianceAbandonThresholdSeconds, 10) || 2)),
    supported_countries: (Array.isArray(countries) ? countries : []).map((value) => String(value || "").trim()).filter(Boolean).slice(0, 100),
    callable_days: normalizeCallableDays(settings),
    callable_window: {
      earliest: String(callable.earliest || "09:00").slice(0, 5),
      latest: String(callable.latest || "20:00").slice(0, 5),
      timezone: String(callable.timezone || "Europe/Warsaw").slice(0, 80),
    },
  };
}

export async function GET() {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT * FROM outbound_settings WHERE id='default' LIMIT 1`);
  return NextResponse.json({ ok: true, settings: mapOutboundSettings(rows[0]) });
}

export async function PUT(request) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const settings = normalizeSettings(await request.json());
    const username = usernameFor(user);
    const { rows } = await pool.query(`INSERT INTO outbound_settings (id, settings, created_by, updated_by) VALUES ('default', $1, $2, $2) ON CONFLICT (id) DO UPDATE SET settings=EXCLUDED.settings, updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING *`, [JSON.stringify(settings), username]);
    return NextResponse.json({ ok: true, settings: mapOutboundSettings(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] save settings error:", err); return jsonError(err.message || "Failed to save settings", 400); }
}
