import { providerResponseStatus } from "@/lib/provider-http-status.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { syncHardphonePhoneNumberAssignment } from "@/lib/hardphones/number-sync.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


// Fresh provider configuration. A messaging failure must never look like an
// unassigned profile: mobile disables that editor until this lookup succeeds.
async function GET_handler(request, { params }) {
  try {
    const { id } = await params;
    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
    const url = `${basePath}/v2/phone_numbers/${encodeURIComponent(id)}`;
    const options = { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, cache: "no-store" };
    const response = await fetch(url, options);
    if (!response.ok) return NextResponse.json({ error: "Failed to retrieve number configuration from Telnyx" }, { status: providerResponseStatus(response.status) });
    const number = await response.json();
    let messaging = null;
    let messagingError = null;
    try {
      const response = await fetch(`${url}/messaging`, options);
      if (response.ok) {
        messaging = (await response.json()).data ?? null;
      }
      if (!messaging) messagingError = "Messaging configuration is unavailable. Voice settings can still be edited.";
    } catch {
      messagingError = "Messaging configuration could not be loaded. Reopen this number to retry.";
    }
    return NextResponse.json({ data: number.data, messaging, messagingAvailable: messaging !== null, messagingError },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    adminRuntimeLogger.error("number_configuration_failed", runtimePayload({ error }));
    return NextResponse.json({ error: "Failed to retrieve number configuration from Telnyx" }, { status: 502 });
  }
}

async function PATCH_handler(request, { params }, authz) {
  try {
    const user = authz.user;

    const { id } = await params;
    const body = await request.json();

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";

    // Separate messaging_profile_id from other updates
    const { messaging_profile_id, ...voiceSettings } = body;

    let result = null;

    // Update voice settings (connection_id, recording, tags, deletion_lock)
    if (Object.keys(voiceSettings).length > 0) {
      const telnyxUrl = `${basePath}/v2/phone_numbers/${id}`;
      const res = await fetch(telnyxUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(voiceSettings),
      });

      if (!res.ok) {
        const errorText = await res.text();
        adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
        return NextResponse.json(
          { error: "Failed to update phone number voice settings" },
          { status: providerResponseStatus(res.status) }
        );
      }

      const data = await res.json();
      result = data.data;
    }

    // Update messaging profile separately if provided
    if (messaging_profile_id !== undefined) {
      const messagingUrl = `${basePath}/v2/phone_numbers/${id}/messaging`;
      const messagingRes = await fetch(messagingUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_profile_id: messaging_profile_id || null,
        }),
      });

      if (!messagingRes.ok) {
        const errorText = await messagingRes.text();
        adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
        return NextResponse.json(
          { error: "Failed to update messaging profile" },
          { status: providerResponseStatus(messagingRes.status) }
        );
      }

      const messagingData = await messagingRes.json();
      // Merge messaging data with voice settings result
      result = { ...result, ...messagingData.data };
    }

    if (result?.id && (voiceSettings.connection_id !== undefined || voiceSettings.voice?.connection_id !== undefined)) {
      const pool = getPostgresPool();
      if (pool) {
        await syncHardphonePhoneNumberAssignment(pool, result).catch((err) => {
          adminRuntimeLogger.warn("hardphone_number_assignment_sync_failed", runtimePayload({ error: err, operation: "numbers_hp_assignment_sync", phone_number_id: result.id }));
        });
      }
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

async function DELETE_handler(request, { params }, authz) {
  try {
    const user = authz.user;

    const { id } = await params;

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
    const telnyxUrl = `${basePath}/v2/phone_numbers/${id}`;

    const res = await fetch(telnyxUrl, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { error: "Failed to delete phone number" },
        { status: providerResponseStatus(res.status) }
      );
    }

    const data = await res.json();

    return NextResponse.json({ data: data.data });
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PATCH = withPermission("numbers:update", PATCH_handler, { route: "/api/admin/numbers/[id]" });
export const DELETE = withPermission("numbers:delete", DELETE_handler, { route: "/api/admin/numbers/[id]" });

export const GET = withPermission("numbers:read", GET_handler, { route: "/api/admin/numbers/[id]" });
