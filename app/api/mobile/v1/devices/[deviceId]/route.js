import { NextResponse } from "next/server";
import { withPermission, AUTHENTICATED } from "@/lib/authz/guard";
import { securityErrorPayload } from "@/lib/security-logging.mjs";
import { devicesLogger, ensureMobileDeviceSchema, removeDevice } from "@/lib/mobile/devices.mjs";

let schemaReady = null;
function ready() {
  schemaReady ||= ensureMobileDeviceSchema().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

/**
 * `DELETE /api/mobile/v1/devices/{deviceId}` — on sign-out, and when an agent
 * revokes a handset from their profile.
 *
 * Leaving a token behind means the ACD keeps offering calls to a phone nobody
 * is holding, and every one of those offers is counted against the agent as
 * missed.
 */
async function DELETE_handler(_request, context, authz) {
  try {
    await ready();
    const { deviceId } = await context.params;
    // Scoped to the caller: the delete is by (device, user), so knowing
    // somebody else's device id is not enough to stop their phone ringing.
    const removed = await removeDevice(authz.user.id, deviceId);

    devicesLogger.info("mobile_device_unregistered", { removed });

    // Idempotent on purpose. Sign-out retries, and a second DELETE that
    // answered 404 would look like a failure the app should report.
    return NextResponse.json({ removed });
  } catch (error) {
    devicesLogger.error("mobile_device_unregister_failed", { ...securityErrorPayload(error) });
    return NextResponse.json({ error: "Failed to remove the device" }, { status: 500 });
  }
}

export const DELETE = withPermission(AUTHENTICATED, DELETE_handler, {
  route: "/api/mobile/v1/devices/[deviceId]",
});
