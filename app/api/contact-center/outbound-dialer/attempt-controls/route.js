export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundAttemptControl, optionalString, requireOutboundSupervisor, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { normalizeAttemptControlLimits, normalizeGlobalMaxAttempts } from "@/lib/outbound-dialer/attempt-limits";

const STATUSES = ["draft", "active", "paused"];
const RESET_PERIODS = ["daily", "weekly", "monthly", "campaign", "lifetime"];
const normalizeStatus = (value) => STATUSES.includes(value) ? value : "draft";
const normalizeResetPeriod = (value) => RESET_PERIODS.includes(value) ? value : "daily";

async function getGlobalMaxAttempts(pool) {
  const { rows } = await pool.query(`SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1`);
  const settings = rows?.[0]?.settings && typeof rows[0].settings === "object" ? rows[0].settings : {};
  return normalizeGlobalMaxAttempts(settings.global_max_attempts ?? settings.globalMaxAttempts);
}

function normalizeAttemptControl(body = {}, globalMaxAttempts = 5) {
  const normalized = normalizeAttemptControlLimits(body, globalMaxAttempts);
  return {
    name: requireString(body.name, "Attempt control name"),
    description: optionalString(body.description),
    status: normalizeStatus(body.status),
    reset_period: normalizeResetPeriod(body.reset_period || body.resetPeriod),
    timezone: optionalString(body.timezone, 80) || "Europe/Warsaw",
    max_attempts_per_contact: normalized.max_attempts_per_contact,
    max_attempts_per_number: normalized.max_attempts_per_number,
    recall_rules: normalized.recall_rules,
    phone_type_rules: normalized.phone_type_rules,
    metadata: safeJson(body.metadata, {}),
  };
}

export async function GET() {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT * FROM outbound_attempt_controls WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`);
  return NextResponse.json({ ok: true, attemptControls: rows.map(mapOutboundAttemptControl) });
}

export async function POST(request) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const globalMaxAttempts = await getGlobalMaxAttempts(pool);
    const body = normalizeAttemptControl(await request.json(), globalMaxAttempts);
    const username = usernameFor(user);
    const { rows } = await pool.query(`INSERT INTO outbound_attempt_controls (name, description, status, reset_period, timezone, max_attempts_per_contact, max_attempts_per_number, recall_rules, phone_type_rules, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`, [body.name, body.description, body.status, body.reset_period, body.timezone, body.max_attempts_per_contact, body.max_attempts_per_number, JSON.stringify(body.recall_rules), JSON.stringify(body.phone_type_rules), JSON.stringify(body.metadata), username]);
    return NextResponse.json({ ok: true, attemptControl: mapOutboundAttemptControl(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] create attempt control error:", err); return jsonError(err.message || "Failed to create attempt control", 400); }
}
