import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isAdmin } from "@/lib/role-utils";
import { syncHardphonePhoneNumberAssignment } from "@/lib/hardphones/number-sync.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const userId = session.user.id;
  const email = session.user.email;
  let user = null;
  if (userId) user = await PgDb.findUserById(userId);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user || !isAdmin(user)) return null;
  return user;
}

export async function PATCH(request, { params }) {
  try {
    const user = await requireAdmin();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
          { status: res.status }
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
          { status: messagingRes.status }
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

export async function DELETE(request, { params }) {
  try {
    const user = await requireAdmin();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
        { status: res.status }
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
