/**
 * The register of mobile devices that may be rung (B-10).
 *
 * A VoIP push reaches a handset through a chain: APNs certificate → Telnyx
 * push credential → SIP connection → *this* device. The Telnyx SDK hands its
 * own token to Telnyx at login, which is why a phone can ring without this
 * table existing at all. What the table is for is everything around that: the
 * ACD deciding which of an agent's devices holds the voice leg (D-M3), the
 * agent revoking a handset they no longer carry, and a sign-out taking a token
 * out of service instead of leaving the floor ringing a phone in a drawer.
 */
import { getPostgresPool } from "../postgres.mjs";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

export const devicesLogger = createDiagnosticLogger("mobile.devices");

export const DEVICE_KINDS = ["ios", "watch"];

export async function ensureMobileDeviceSchema(db = null) {
  const client = db || getPostgresPool();
  await client.query(`
    CREATE TABLE IF NOT EXISTS cc_mobile_devices (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('ios','watch')),
      voip_token TEXT,
      alert_token TEXT,
      name TEXT,
      system_version TEXT,
      app_version TEXT,
      bundle_identifier TEXT NOT NULL,
      environment TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE cc_mobile_devices ADD COLUMN IF NOT EXISTS auth_session_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_cc_mobile_devices_user
      ON cc_mobile_devices (user_id, updated_at DESC);
  `);
}

/** Trims and bounds a string, so a long field cannot become a storage problem. */
function text(value, limit = 200) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

/**
 * Validates a registration as the app sends it.
 *
 * `environment` is recorded rather than enforced. The field that actually
 * decides whether a push can be delivered is the bundle identifier — Debug and
 * Release are different apps, with different APNs certificates and different
 * Telnyx push credentials — so the sender filters on that. Rejecting on the
 * environment string as well would mean a deployment whose APP_ENV is spelled
 * unexpectedly refuses every registration and no phone rings, with nothing on
 * screen to explain it.
 */
export function readRegistration(body) {
  const deviceId = text(body?.deviceId, 128);
  if (!deviceId) throw new Error("deviceId is required");

  const kind = text(body?.kind, 16);
  if (!DEVICE_KINDS.includes(kind)) {
    throw new Error(`kind must be one of ${DEVICE_KINDS.join(", ")}`);
  }

  const bundleIdentifier = text(body?.bundleIdentifier, 200);
  if (!bundleIdentifier) throw new Error("bundleIdentifier is required");

  return {
    deviceId,
    kind,
    // Tokens are hex from PushKit/APNs. Anything else is a client bug, and
    // storing it would mean a push attempt that can only fail.
    voipToken: hexToken(body?.voipToken),
    alertToken: hexToken(body?.alertToken),
    name: text(body?.name, 120),
    systemVersion: text(body?.systemVersion, 40),
    appVersion: text(body?.appVersion, 40),
    bundleIdentifier,
    environment: text(body?.environment, 40) || "unknown",
  };
}

function hexToken(value) {
  const token = String(value ?? "").trim();
  if (!token) return null;
  if (!/^[0-9a-fA-F]{32,200}$/.test(token)) throw new Error("push tokens must be hex");
  return token.toLowerCase();
}

/**
 * Idempotent upsert keyed on the device.
 *
 * Keyed on the device and not on (user, device) deliberately: when a handset
 * changes hands the row moves to the new user, and the previous one stops
 * being offered calls on a phone they no longer hold.
 */
export async function upsertDevice(userId, registration, db = null) {
  const client = db || getPostgresPool();
  const { rows } = await client.query(
    `INSERT INTO cc_mobile_devices
       (device_id, user_id, kind, voip_token, alert_token, name,
        system_version, app_version, bundle_identifier, environment, auth_session_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
     ON CONFLICT (device_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       auth_session_id = EXCLUDED.auth_session_id,
       kind = EXCLUDED.kind,
       voip_token = EXCLUDED.voip_token,
       alert_token = EXCLUDED.alert_token,
       name = EXCLUDED.name,
       system_version = EXCLUDED.system_version,
       app_version = EXCLUDED.app_version,
       bundle_identifier = EXCLUDED.bundle_identifier,
       environment = EXCLUDED.environment,
       updated_at = NOW()
     RETURNING *`,
    [
      registration.deviceId, String(userId), registration.kind,
      registration.voipToken, registration.alertToken, registration.name,
      registration.systemVersion, registration.appVersion,
      registration.bundleIdentifier, registration.environment, registration.authSessionId || null,
    ],
  );
  return mapDevice(rows[0]);
}

/**
 * Removes a device, but only the caller's own.
 *
 * Scoped to the user on purpose: without it, knowing another agent's device id
 * would be enough to stop their phone ringing, and nothing would look broken
 * until a call went unanswered.
 */
export async function removeDevice(userId, deviceId, db = null) {
  const client = db || getPostgresPool();
  const { rowCount } = await client.query(
    `DELETE FROM cc_mobile_devices WHERE device_id = $1 AND user_id = $2`,
    [String(deviceId), String(userId)],
  );
  return rowCount > 0;
}

export async function listDevices(userId, db = null) {
  const client = db || getPostgresPool();
  const { rows } = await client.query(
    `SELECT * FROM cc_mobile_devices WHERE user_id = $1 ORDER BY updated_at DESC`,
    [String(userId)],
  );
  return rows.map(mapDevice);
}

/**
 * The devices the ACD may ring for a user.
 *
 * Filtered on the bundle identifier, because that is what the push credential
 * is issued against: a token minted for `…contactcenter.dev` cannot be
 * delivered through the production credential, and attempting it looks exactly
 * like an agent who did not pick up.
 */
export async function ringableDevices(userId, bundleIdentifier, db = null) {
  const client = db || getPostgresPool();
  const { rows } = await client.query(
    `SELECT * FROM cc_mobile_devices
      WHERE user_id = $1 AND bundle_identifier = $2 AND voip_token IS NOT NULL
      ORDER BY updated_at DESC`,
    [String(userId), String(bundleIdentifier)],
  );
  return rows.map(mapDevice);
}

function mapDevice(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    kind: row.kind,
    name: row.name,
    systemVersion: row.system_version,
    appVersion: row.app_version,
    bundleIdentifier: row.bundle_identifier,
    environment: row.environment,
    // The tokens themselves never leave the server. The app only needs to know
    // whether this handset could be rung; echoing a push token back would put
    // it in a response body and a log for no gain.
    canReceiveCalls: Boolean(row.voip_token),
    canReceiveAlerts: Boolean(row.alert_token),
    updatedAt: row.updated_at,
  };
}
