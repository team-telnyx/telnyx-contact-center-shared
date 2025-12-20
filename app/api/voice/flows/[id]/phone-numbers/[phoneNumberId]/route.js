import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import { unassignPhoneNumberFromApp } from "@/lib/telnyx-voice-apps";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/voice/flows/[id]/phone-numbers/[phoneNumberId]
 * Unassign a phone number from a flow
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

    const username = session.user.email;
    const { id, phoneNumberId } = await params;

    // Verify flow exists and belongs to user
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
