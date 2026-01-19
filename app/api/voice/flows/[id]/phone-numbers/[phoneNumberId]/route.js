import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import { unassignPhoneNumberFromApp } from "@/lib/telnyx-voice-apps";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/voice/flows/[id]/phone-numbers/[phoneNumberId]
 * Unassign a phone number from a flow
 * Admin users can unassign phone numbers from any flow
 */
export async function DELETE(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Check if user is admin
    const userId = session?.user?.id || null;
    const email = session.user.email;
    let user = null;
    if (userId) user = await PgDb.findUserById(userId);
    if (!user && email) user = await PgDb.findUserByUsername(email);
    
    // Admin users can access any flow (pass null username)
    // Non-admin users only see their own flows
    const username = user && isAdmin(user) ? null : email;
    const { id, phoneNumberId } = await params;

    // Verify flow exists and belongs to user (or admin can access any)
    const flow = await VoiceFlowDb.getFlowById(id, username);
    if (!flow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 }
      );
    }

    // Get phone number assignment
    const phoneNumbers = await VoiceFlowDb.getFlowPhoneNumbers(id);
    const phoneNumber = phoneNumbers.find(
      (pn) => pn.phone_number_id === phoneNumberId
    );

    if (!phoneNumber) {
      return NextResponse.json(
        { ok: false, error: "Phone number not assigned to this flow" },
        { status: 404 }
      );
    }

    // Unassign phone number from Telnyx Voice Application
    try {
      await unassignPhoneNumberFromApp(phoneNumberId);
    } catch (error) {
      console.error("[API] Failed to unassign phone number from app:", error);
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to unassign phone number: ${error.message}`,
        },
        { status: 500 }
      );
    }

    // Delete record from database
    const result = await VoiceFlowDb.unassignPhoneNumber(id, phoneNumberId);

    if (!result) {
      return NextResponse.json(
        { ok: false, error: "Failed to unassign phone number" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      unassigned: true,
    });
  } catch (error) {
    console.error("[API] Error unassigning phone number:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error.message || "Failed to unassign phone number",
      },
      { status: 500 }
    );
  }
}
