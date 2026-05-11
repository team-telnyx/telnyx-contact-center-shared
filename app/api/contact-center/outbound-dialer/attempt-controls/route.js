import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundAttemptControl, optionalString, requireOutboundSupervisor, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";

const STATUSES = ["draft", "active", "paused"];
const RESET_PERIODS = ["daily", "weekly", "monthly", "campaign", "lifetime"];
const normalizeStatus = (value) => STATUSES.includes(value) ? value : "draft";
const normalizeResetPeriod = (value) => RESET_PERIODS.includes(value) ? value : "daily";
const normalizeInt = (value, fallback, min = 0, max = 999) => Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback));

function normalizeAttemptControl(body = {}) {
  return {
    name: requireString(body.name, "Attempt control name"),
    description: optionalString(body.description),
    status: normalizeStatus(body.status),
    reset_period: normalizeResetPeriod(body.reset_period || body.resetPeriod),
    timezone: optionalString(body.timezone, 80) || "Europe/Warsaw",
    max_attempts_per_contact: normalizeInt(body.max_attempts_per_contact ?? body.maxAttemptsPerContact, 4, 1, 100),
    max_attempts_per_number: normalizeInt(body.max_attempts_per_number ?? body.maxAttemptsPerNumber, 2, 1, 100),
    recall_rules: safeJson(body.recall_rules ?? body.recallRules, []),
    phone_type_rules: safeJson(body.phone_type_rules ?? body.phoneTypeRules, []),
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
    const body = normalizeAttemptControl(await request.json());
    const username = usernameFor(user);
    const { rows } = await pool.query(`INSERT INTO outbound_attempt_controls (name, description, status, reset_period, timezone, max_attempts_per_contact, max_attempts_per_number, recall_rules, phone_type_rules, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`, [body.name, body.description, body.status, body.reset_period, body.timezone, body.max_attempts_per_contact, body.max_attempts_per_number, JSON.stringify(body.recall_rules), JSON.stringify(body.phone_type_rules), JSON.stringify(body.metadata), username]);
    return NextResponse.json({ ok: true, attemptControl: mapOutboundAttemptControl(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] create attempt control error:", err); return jsonError(err.message || "Failed to create attempt control", 400); }
}
