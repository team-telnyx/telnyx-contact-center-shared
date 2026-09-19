// Send-time suppression for messaging campaigns: DNC lists (phone and email),
// channel opt-outs, consent fields, test-mode allowlists and contact windows.
import { currentTimeParts, parseHm, passesCampaignFilter, passesTimeSet, withinAttemptControlPerNumber } from "../execution.js";
import { normalizeEmailAddress } from "./destination.mjs";

const parse = (value, fallback = {}) => {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

export async function isSuppressedByMessagingDnc(pool, campaign, channel, address) {
  const dncListId = parse(campaign?.metadata, {})?.dnc_list_id || null;
  if (!dncListId || !address) return false;
  const candidates = [];
  if (channel === "email") { const email = normalizeEmailAddress(address); if (email) candidates.push(["email", email]); }
  else { const digits = String(address).replace(/\D/g, ""); if (digits) { candidates.push(["phone", digits]); candidates.push(["phone", `+${digits}`]); } }
  if (!candidates.length) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM outbound_dnc_entries e
     INNER JOIN outbound_dnc_lists l ON l.id = e.dnc_list_id AND l.status = 'active'
     WHERE e.dnc_list_id = $1 AND (e.value_type, e.normalized_value) IN (${candidates.map((_, idx) => `($${idx * 2 + 2}, $${idx * 2 + 3})`).join(",")})
     LIMIT 1`,
    [dncListId, ...candidates.flat()],
  );
  return Boolean(rows[0]);
}

// STOP mirrored from inbound keywords (any Contact Center number when the
// workspace honours opt-outs across numbers) or learned from a provider
// rejection of an earlier campaign message.
export async function isOptedOut(pool, { channel, address, senderNumberIds = [], settings = {} }) {
  if (!address) return false;
  if (channel === "sms") {
    const across = settings?.sms?.honor_opt_out_across_numbers !== false;
    const { rows } = await pool.query(
      across
        ? `SELECT 1 FROM cc_sms_threads WHERE customer_address = $1 AND opted_out_at IS NOT NULL LIMIT 1`
        : `SELECT 1 FROM cc_sms_threads WHERE customer_address = $1 AND opted_out_at IS NOT NULL AND number_id = ANY($2::uuid[]) LIMIT 1`,
      across ? [address] : [address, senderNumberIds],
    );
    if (rows[0]) return true;
  }
  if (channel === "whatsapp") {
    const { rows } = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='cc_whatsapp_threads' AND column_name='opted_out_at'`);
    if (rows[0]) {
      const optedOut = await pool.query(`SELECT 1 FROM cc_whatsapp_threads WHERE customer_address = $1 AND opted_out_at IS NOT NULL LIMIT 1`, [address]);
      if (optedOut.rows[0]) return true;
    }
  }
  const learned = await pool.query(
    `SELECT 1 FROM outbound_attempt_ledger
     WHERE channel = $1 AND to_address = $2 AND COALESCE(metadata->>'reason_code','') = 'opted_out' AND created_at > NOW() - INTERVAL '365 days'
     LIMIT 1`,
    [channel, address],
  );
  return Boolean(learned.rows[0]);
}

export function consentGranted(config = {}, rowData = {}) {
  const field = String(config?.consent?.field || "").trim();
  if (!field) return true;
  const accepted = (config.consent?.accepted_values || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  const actual = String(parse(rowData, {})?.[field] ?? "").trim().toLowerCase();
  if (!accepted.length) return ["yes", "true", "1", "opted_in", "opt_in", "granted", "y"].includes(actual);
  return accepted.includes(actual);
}

export function allowedByTestMode(settings = {}, address) {
  const testMode = settings?.safety?.test_mode || {};
  if (!testMode.enabled) return true;
  const value = String(address || "").trim().toLowerCase();
  const digits = value.replace(/\D/g, "");
  return (testMode.allowlist || []).some((entry) => {
    const candidate = String(entry || "").trim().toLowerCase();
    if (!candidate) return false;
    if (candidate === value) return true;
    const candidateDigits = candidate.replace(/\D/g, "");
    return Boolean(digits) && candidateDigits.length >= 7 && candidateDigits === digits;
  });
}

// Global callable window from the workspace settings, used when the campaign
// has no time set of its own.
export function withinCallableDefaults(outboundSettings = {}, now = new Date()) {
  const settings = parse(outboundSettings, {});
  const days = Array.isArray(settings.callable_days) && settings.callable_days.length ? settings.callable_days : ["mon", "tue", "wed", "thu", "fri"];
  const window = settings.callable_window || {};
  const parts = currentTimeParts(window.timezone || "Europe/Warsaw", now);
  if (!days.includes(parts.weekday)) return false;
  return parts.minutes >= parseHm(window.earliest || "09:00", 0) && parts.minutes <= parseHm(window.latest || "20:00", 24 * 60);
}

export async function passesMessagingWindow(pool, { campaign, outboundSettings = {}, messagingSettings = {} }) {
  const metadata = parse(campaign?.metadata, {});
  if (metadata.contactable_time_set_id || metadata.time_set_id) return passesTimeSet(pool, campaign);
  if (messagingSettings?.windows?.use_callable_defaults === false) return true;
  if (campaign?.channel === "email") return true;
  return withinCallableDefaults(outboundSettings);
}

export async function checkMessagingSuppression(pool, { channel, address, contactRecord, campaign, config, settings, senderNumberIds = [] }) {
  if (!address) return { suppressed: true, reason: "missing_destination" };
  if (!allowedByTestMode(settings, address)) return { suppressed: true, reason: "test_mode_allowlist" };
  if (!(await passesCampaignFilter(pool, campaign, contactRecord))) return { suppressed: true, reason: "filtered_out" };
  if (await isSuppressedByMessagingDnc(pool, campaign, channel, address)) return { suppressed: true, reason: "dnc_match" };
  if (await isOptedOut(pool, { channel, address, senderNumberIds, settings })) return { suppressed: true, reason: "opted_out" };
  if (!consentGranted(config, contactRecord?.row_data)) return { suppressed: true, reason: "consent_missing" };
  if (!(await withinAttemptControlPerNumber(pool, campaign, contactRecord?.id, address))) return { suppressed: true, reason: "max_attempts_per_number_reached" };
  return { suppressed: false, reason: null };
}
