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
const normalizeAttemptControl = (body = {}, globalMaxAttempts = 5) => {
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
};

export async function PUT(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { attemptControlId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const globalMaxAttempts = await getGlobalMaxAttempts(pool);
    const body = normalizeAttemptControl(await request.json(), globalMaxAttempts);
    const { rows } = await pool.query(`UPDATE outbound_attempt_controls SET name=$1, description=$2, status=$3, reset_period=$4, timezone=$5, max_attempts_per_contact=$6, max_attempts_per_number=$7, recall_rules=$8, phone_type_rules=$9, metadata=$10, updated_by=$11, updated_at=NOW() WHERE id=$12 AND status <> 'archived' RETURNING *`, [body.name, body.description, body.status, body.reset_period, body.timezone, body.max_attempts_per_contact, body.max_attempts_per_number, JSON.stringify(body.recall_rules), JSON.stringify(body.phone_type_rules), JSON.stringify(body.metadata), usernameFor(user), attemptControlId]);
    if (!rows[0]) return jsonError("Attempt control not found", 404);
    return NextResponse.json({ ok: true, attemptControl: mapOutboundAttemptControl(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] update attempt control error:", err); return jsonError(err.message || "Failed to update attempt control", 400); }
}

export async function DELETE(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { attemptControlId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`UPDATE outbound_attempt_controls SET status='archived', updated_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [usernameFor(user), attemptControlId]);
  if (!rows[0]) return jsonError("Attempt control not found", 404);
  return NextResponse.json({ ok: true, attemptControl: mapOutboundAttemptControl(rows[0]) });
}
