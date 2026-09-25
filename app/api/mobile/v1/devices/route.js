import { NextResponse } from "next/server";
import { withPermission, AUTHENTICATED } from "@/lib/authz/guard";
import { securityErrorPayload } from "@/lib/security-logging.mjs";
import {
  devicesLogger,
  ensureMobileDeviceSchema,
  listDevices,
  readRegistration,
  upsertDevice,
} from "@/lib/mobile/devices.mjs";

// The table is created on first use rather than in the schema bootstrap.
// That bootstrap runs its whole body on every start, and an earlier incident
// showed how expensive it is when one statement in it fails, so a new feature
// earns its own narrow path. The promise is cached: the DDL runs once per
// process, not once per request.
let schemaReady = null;
function ready() {
  schemaReady ||= ensureMobileDeviceSchema().catch((error) => {
    schemaReady = null; // so the next request retries rather than failing forever
    throw error;
  });
  return schemaReady;
}

/**
 * `PUT /api/mobile/v1/devices` — register or update this device.
 *
 * A PUT because the app calls it on every launch and whenever iOS rotates a
 * token, which it does without warning. A POST would leave a row per call and
 * the ACD ringing tokens that no longer exist.
 */
async function PUT_handler(request, _context, authz) {
  try {
    await ready();
    const registration = readRegistration(await request.json().catch(() => null));
    const device = await upsertDevice(authz.user.id, { ...registration, authSessionId: authz.user.authSessionId });

    devicesLogger.info("mobile_device_registered", {
      deviceKind: device.kind,
      canReceiveCalls: device.canReceiveCalls,
      bundleIdentifier: device.bundleIdentifier,
      environment: device.environment,
    });

    return NextResponse.json({ device });
  } catch (error) {
    // A malformed registration is the client's bug and is worth saying so
    // plainly; anything else is ours.
    const isClientError = /required|must be/.test(error?.message || "");
    devicesLogger.error("mobile_device_register_failed", { ...securityErrorPayload(error) });
    return NextResponse.json(
      { error: isClientError ? error.message : "Failed to register the device" },
      { status: isClientError ? 400 : 500 },
    );
  }
}

/** `GET /api/mobile/v1/devices` — the caller's own devices, for revocation. */
async function GET_handler(_request, _context, authz) {
  try {
    await ready();
    return NextResponse.json({ devices: await listDevices(authz.user.id) });
  } catch (error) {
    devicesLogger.error("mobile_device_list_failed", { ...securityErrorPayload(error) });
    return NextResponse.json({ error: "Failed to list devices" }, { status: 500 });
  }
}

// Registering the handset you signed in on needs no permission beyond being
// signed in: an agent, a supervisor carrying alerts and an admin all do it.
export const PUT = withPermission(AUTHENTICATED, PUT_handler, { route: "/api/mobile/v1/devices" });
export const GET = withPermission(AUTHENTICATED, GET_handler, { route: "/api/mobile/v1/devices" });
