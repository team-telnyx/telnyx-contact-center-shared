import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import {
  assignPhoneNumberToApp,
  unassignPhoneNumberFromApp,
} from "@/lib/telnyx-voice-apps";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/flows/[id]/phone-numbers
 * List phone numbers assigned to a flow
 */
export async function GET(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const username = session.user.email;
    const { id } = await params;

    // Verify flow exists and belongs to user
    const flow = await VoiceFlowDb.getFlowById(id, username);
    if (!flow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 }
      );
    }

    const phoneNumbers = await VoiceFlowDb.getFlowPhoneNumbers(id);

    return NextResponse.json({
      ok: true,
      phone_numbers: phoneNumbers,
    });
  } catch (error) {
    console.error("[API] Error listing phone numbers:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to list phone numbers" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/voice/flows/[id]/phone-numbers
 * Assign a phone number to a flow
 */
export async function POST(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const username = session.user.email;
    const { id } = await params;
    const body = await request.json();

    const { phone_number_id, phone_number } = body;

    if (!phone_number_id || !phone_number) {
      return NextResponse.json(
        { ok: false, error: "phone_number_id and phone_number are required" },
        { status: 400 }
      );
    }

    // Verify flow exists and belongs to user
    const flow = await VoiceFlowDb.getFlowById(id, username);
    if (!flow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 }
      );
    }

    if (!flow.telnyx_voice_app_id) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Flow does not have a voice application. Please create the flow first.",
        },
        { status: 400 }
      );
    }

    // Assign phone number to Telnyx Voice Application
    try {
      await assignPhoneNumberToApp(phone_number_id, flow.telnyx_voice_app_id);
    } catch (error) {
      console.error("[API] Failed to assign phone number to app:", error);
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to assign phone number: ${error.message}`,
        },
        { status: 500 }
      );
    }

    // Create record in database
    const assignment = await VoiceFlowDb.assignPhoneNumber(
      id,
      phone_number_id,
      phone_number,
      username
    );

    return NextResponse.json({
      ok: true,
      assignment,
    });
  } catch (error) {
    console.error("[API] Error assigning phone number:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to assign phone number" },
      { status: 500 }
    );
  }
}
