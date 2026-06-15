import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

// Single diagnostic topic for everything under hardphone provisioning &
// CTI. We deliberately keep the `platform.phone-provisioning` topic name so
// the runtime/jsonl logs (app-*.jsonl) and any topic-based log filtering stay
// stable. Previously each provisioning route redefined its own silent
// `logEvent()` DB writer and the serve path borrowed the unrelated
// `voice.flow` logger, so nothing actually surfaced in the phone-provisioning
// log stream. This module is the one place that:
//   1. writes the durable audit row to hp_provisioning_events (UI Logs rail), and
//   2. emits a real runtime log line on the platform.phone-provisioning topic,
// so provisioning activity "faktycznie leci" to both surfaces.
export const phoneProvisioningLogger = createDiagnosticLogger("platform.phone-provisioning");

const LEVEL_FOR_EVENT = {
  unknown_phone_request: "warn",
  disabled_phone_request: "warn",
  config_generation_failed: "warn",
  provisioning_event_insert_failed: "error",
};

function levelForEvent(eventType) {
  return LEVEL_FOR_EVENT[eventType] || "info";
}

/**
 * Centralized hardphone provisioning event recorder.
 *
 * Writes one durable row to `hp_provisioning_events` (consumed by the admin
 * Logs rail / dashboard) AND emits a runtime diagnostic log on the
 * `platform.phone-provisioning` topic. DB failures are swallowed (provisioning
 * must never 500 because of an audit insert) but are surfaced as an error-level
 * runtime log instead of the previous silent `catch {}`.
 *
 * @param {object|null} pool - pg pool (may be null in tests / before init)
 * @param {object} event
 * @param {string|null} [event.phoneId]
 * @param {string|null} [event.mac]
 * @param {string} event.eventType
 * @param {object} [event.detail]
 * @returns {Promise<boolean>} whether the DB row was written
 */
export async function recordProvisioningEvent(pool, { phoneId = null, mac = null, eventType, detail = {} } = {}) {
  const level = levelForEvent(eventType);
  // Always emit the runtime log, even if the DB write later fails — the log
  // stream is the thing that proves provisioning activity is happening.
  phoneProvisioningLogger[level]?.(`hardphone_${eventType}`, {
    operation: "provisioning_event",
    eventType,
    phoneId: phoneId || undefined,
    mac: mac || undefined,
    detail,
  });

  if (!pool) return false;

  try {
    await pool.query(
      `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail) VALUES ($1, $2, $3, $4)`,
      [phoneId, mac, eventType, JSON.stringify(detail || {})],
    );
    return true;
  } catch (error) {
    phoneProvisioningLogger.error("hardphone_provisioning_event_insert_failed", {
      operation: "provisioning_event",
      eventType,
      phoneId: phoneId || undefined,
      mac: mac || undefined,
      errorMessage: error?.message || String(error),
    });
    return false;
  }
}
