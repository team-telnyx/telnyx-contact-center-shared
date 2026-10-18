import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import pg from "pg";

import { readDotEnvPostgres } from "./helpers/acd-test-db.mjs";
import {
  ensureMobileDeviceSchema,
  listDevices,
  readRegistration,
  removeDevice,
  ringableDevices,
  upsertDevice,
} from "../lib/mobile/devices.mjs";

const VOIP = "a".repeat(64);
const OTHER_VOIP = "b".repeat(64);
const DEV_BUNDLE = "com.example.contactcenter.dev";
const PROD_BUNDLE = "com.example.contactcenter";

function registration(overrides = {}) {
  return {
    deviceId: "device-1",
    kind: "ios",
    voipToken: VOIP,
    alertToken: null,
    name: "Demo's iPhone",
    systemVersion: "26.0",
    appVersion: "0.1.0",
    bundleIdentifier: DEV_BUNDLE,
    environment: "development",
    ...overrides,
  };
}

describe("reading a registration", () => {
  it("accepts what the app sends", () => {
    const parsed = readRegistration(registration());
    assert.equal(parsed.deviceId, "device-1");
    assert.equal(parsed.kind, "ios");
    assert.equal(parsed.voipToken, VOIP);
  });

  it("requires the fields a push cannot be delivered without", () => {
    assert.throws(() => readRegistration(registration({ deviceId: "  " })), /deviceId is required/);
    assert.throws(
      () => readRegistration(registration({ bundleIdentifier: null })),
      /bundleIdentifier is required/,
      "Debug and Release are different apps with different push credentials",
    );
    assert.throws(() => readRegistration(registration({ kind: "unknown" })), /kind must be one of/);
  });

  it("refuses a token that is not hex, rather than storing one that can only fail", () => {
    assert.throws(() => readRegistration(registration({ voipToken: "not-a-token" })), /hex/);
    assert.throws(() => readRegistration(registration({ voipToken: "ab" })), /hex/);
  });

  it("treats a missing token as a device that cannot be rung yet", () => {
    // PushKit may not have produced one at first launch. Recording the device
    // anyway is what lets the app say so instead of failing silently.
    const parsed = readRegistration(registration({ voipToken: null }));
    assert.equal(parsed.voipToken, null);
  });

  it("records the environment without enforcing it", () => {
    // The bundle identifier decides deliverability; the environment string is
    // advisory. Rejecting on it would let one misspelled APP_ENV stop every
    // phone from ringing, with nothing on screen to say why.
    const parsed = readRegistration(registration({ environment: "staging" }));
    assert.equal(parsed.environment, "staging");
  });

  it("accepts Android FCM credentials without APNs fields and preserves case", () => {
    const parsed = readRegistration(registration({ kind: "android", platform: "android", voipToken: null, fcmToken: "Firebase:Opaque-ABC_123" }));
    assert.equal(parsed.platform, "android");
    assert.equal(parsed.fcmToken, "Firebase:Opaque-ABC_123");
    assert.equal(parsed.voipToken, null);
    assert.equal(parsed.alertToken, null);
    assert.equal(readRegistration(registration()).platform, null);
    assert.equal(readRegistration(registration()).fcmToken, null);
  });

  it("rejects malformed FCM credentials without echoing them", () => {
    for (const value of [123, {}, "a b", "x".repeat(4097)]) {
      assert.throws(() => readRegistration(registration({ kind: "android", fcmToken: value })), /fcmToken must/);
    }
    assert.throws(() => readRegistration(registration({ platform: "android" })), /platform must match/);
    assert.throws(() => readRegistration(registration({ fcmToken: "wrong-platform-token" })), /fcmToken must belong/);
  });
});

describe("the device register", () => {
  const database = "cc_mobile_devices_test";
  let pool = null;

  before(async () => {
    const base = readDotEnvPostgres();
    let admin;
    try {
      admin = new pg.Pool({ ...base, max: 1, connectionTimeoutMillis: 2500 });
      const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [database]);
      if (!exists.rows.length) await admin.query(`CREATE DATABASE ${database}`);
    } catch {
      return; // no PostgreSQL here; the suite skips below
    } finally {
      await admin?.end().catch(() => {});
    }
    pool = new pg.Pool({ ...base, database, max: 4, connectionTimeoutMillis: 2500 });
    await pool.query("DROP TABLE IF EXISTS cc_mobile_devices");
    await ensureMobileDeviceSchema(pool);
  });

  after(async () => { await pool?.end().catch(() => {}); });

  // The skip has to be decided inside the test. node:test evaluates an `it`
  // options object while collecting tests — before `before()` has run — so a
  // `{ skip: !pool }` computed there is always true and the whole suite goes
  // quiet while reporting success.
  const withDb = (name, body) =>
    it(name, async (t) => {
      if (!pool) return t.skip("PostgreSQL unreachable");
      await body();
    });

  withDb("registers a device and reports that it can be rung", async () => {
    const device = await upsertDevice("user-1", readRegistration(registration()), pool);
    assert.equal(device.deviceId, "device-1");
    assert.equal(device.canReceiveCalls, true);
  });

  withDb("never echoes a push token back", async () => {
    // A token in a response body is a token in a log and in a proxy cache.
    const device = await upsertDevice("user-1", readRegistration(registration()), pool);
    assert.equal(JSON.stringify(device).includes(VOIP), false);
  });

  withDb("a second launch updates the row instead of adding one", async () => {
    await upsertDevice("user-1", readRegistration(registration()), pool);
    await upsertDevice("user-1", readRegistration(registration({ voipToken: OTHER_VOIP })), pool);
    const devices = await listDevices("user-1", pool);
    assert.equal(devices.filter((d) => d.deviceId === "device-1").length, 1);
    // iOS rotates tokens without warning; the newest one must win.
    const ringable = await ringableDevices("user-1", DEV_BUNDLE, pool);
    assert.equal(ringable.length, 1);
  });

  withDb("a handset that changes hands stops ringing for its previous owner", async () => {
    await upsertDevice("user-1", readRegistration(registration()), pool);
    await upsertDevice("user-2", readRegistration(registration()), pool);
    assert.deepEqual(await listDevices("user-1", pool), []);
    assert.equal((await listDevices("user-2", pool)).length, 1);
  });

  withDb("a device with no token is registered but not ringable", async () => {
    await upsertDevice("user-3", readRegistration(registration({ deviceId: "d-3", voipToken: null })), pool);
    assert.equal((await listDevices("user-3", pool)).length, 1);
    assert.deepEqual(await ringableDevices("user-3", DEV_BUNDLE, pool), []);
  });

  withDb("a production credential is never offered a dev token", async () => {
    // The failure this prevents is invisible: the push is accepted, never
    // delivered, and the agent is recorded as having missed the call.
    await upsertDevice("user-4", readRegistration(registration({ deviceId: "d-4" })), pool);
    assert.deepEqual(await ringableDevices("user-4", PROD_BUNDLE, pool), []);
    assert.equal((await ringableDevices("user-4", DEV_BUNDLE, pool)).length, 1);
  });

  withDb("one agent cannot unregister another's handset", async () => {
    await upsertDevice("user-5", readRegistration(registration({ deviceId: "d-5" })), pool);
    assert.equal(await removeDevice("intruder", "d-5", pool), false);
    assert.equal((await listDevices("user-5", pool)).length, 1);
    assert.equal(await removeDevice("user-5", "d-5", pool), true);
    assert.deepEqual(await listDevices("user-5", pool), []);
  });

  withDb("Android storage, rotation, eligibility and deletion keep tokens server-side", async () => {
    const input = readRegistration(registration({ deviceId: "android-device", kind: "android", platform: "android", voipToken: null, fcmToken: "FCM:opaqueToken" }));
    const device = await upsertDevice("android-user", { ...input, authSessionId: "android-login" }, pool);
    assert.equal(device.canReceiveCalls, true);
    assert.equal(device.canReceiveAlerts, true);
    assert.equal(device.platform, "android");
    assert.ok(!JSON.stringify(device).includes(input.fcmToken));
    const row = (await pool.query("SELECT * FROM cc_mobile_devices WHERE device_id=$1", [input.deviceId])).rows[0];
    assert.equal(row.fcm_token, input.fcmToken);
    assert.equal(row.auth_session_id, "android-login");
    assert.equal((await ringableDevices("android-user", DEV_BUNDLE, pool)).length, 1);
    await upsertDevice("android-user", { ...input, fcmToken: null }, pool);
    assert.equal((await listDevices("android-user", pool))[0].canReceiveAlerts, false);
    assert.deepEqual(await ringableDevices("android-user", DEV_BUNDLE, pool), []);
    assert.equal(await removeDevice("another-user", input.deviceId, pool), false);
    assert.equal(await removeDevice("android-user", input.deviceId, pool), true);
  });
});

describe("the device routes", () => {
  it("scope every operation to the signed-in caller", async () => {
    const collection = await readFile(new URL("../app/api/mobile/v1/devices/route.js", import.meta.url), "utf8");
    const item = await readFile(new URL("../app/api/mobile/v1/devices/[deviceId]/route.js", import.meta.url), "utf8");

    assert.match(collection, /upsertDevice\(authz\.user\.id,/);
    assert.match(collection, /listDevices\(authz\.user\.id\)/);
    assert.match(item, /removeDevice\(authz\.user\.id, deviceId\)/);

    for (const source of [collection, item]) {
      assert.match(source, /withPermission\(AUTHENTICATED/);
      assert.doesNotMatch(source, /export (async )?function (GET|PUT|DELETE)\(/);
    }
  });

  it("answer a repeated sign-out without reporting a failure", () => {
    // Sign-out retries. A second DELETE that answered 404 would look to the
    // app like something it should tell the agent about.
    return readFile(new URL("../app/api/mobile/v1/devices/[deviceId]/route.js", import.meta.url), "utf8")
      .then((source) => {
        assert.match(source, /NextResponse\.json\(\{ removed \}\)/);
        assert.doesNotMatch(source, /status: 404/);
      });
  });
});
