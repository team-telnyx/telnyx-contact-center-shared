import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import {
  updateVoiceApplication,
  deleteVoiceApplication,
  getVoiceApplication,
} from "@/lib/telnyx-voice-apps";
import { unassignPhoneNumberFromApp } from "@/lib/telnyx-voice-apps";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/flows/[id]
 * Get a single flow by ID
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

    const flow = await VoiceFlowDb.getFlowById(id, username);

    if (!flow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 }
      );
    }

    // Map variables to globalVariables for UI compatibility
    const flowResponse = {
      ...flow,
      globalVariables: flow.variables,
    };

    return NextResponse.json({
      ok: true,
      flow: flowResponse,
    });
  } catch (error) {
    console.error("[API] Error getting flow:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to get flow" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/voice/flows/[id]
 * Update a flow
 */
export async function PUT(request, { params }) {
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

    // Get existing flow
    const existingFlow = await VoiceFlowDb.getFlowById(id, username);
    if (!existingFlow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 }
      );
    }

    const updates = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.nodes !== undefined) updates.nodes = body.nodes;
    if (body.edges !== undefined) updates.edges = body.edges;
    if (body.globalVariables !== undefined)
      updates.variables = body.globalVariables;
    else if (body.variables !== undefined) updates.variables = body.variables;
    if (body.metadata !== undefined) updates.metadata = body.metadata;

    // Update voice application name if flow name changed
    if (body.name !== undefined && existingFlow.telnyx_voice_app_id) {
      try {
        await updateVoiceApplication(existingFlow.telnyx_voice_app_id, {
          application_name: body.name,
        });
      } catch (error) {
        console.error("[API] Failed to update voice application name:", error);
        // Don't fail the flow update if voice app update fails
      }
    }

    const flow = await VoiceFlowDb.updateFlow(id, username, updates);

    if (!flow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 }
      );
    }

    // Map variables to globalVariables for UI compatibility
    const flowResponse = {
      ...flow,
      globalVariables: flow.variables,
    };

    return NextResponse.json({
      ok: true,
      flow: flowResponse,
    });
  } catch (error) {
    console.error("[API] Error updating flow:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to update flow" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/voice/flows/[id]
 * Delete a flow
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
    const { id } = await params;

    // Get flow to retrieve voice app ID and phone numbers
    const flow = await VoiceFlowDb.getFlowById(id, username);
    if (!flow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 }
      );
    }

    // Unassign all phone numbers from the voice application
    if (flow.telnyx_voice_app_id) {
      const phoneNumbers = await VoiceFlowDb.getFlowPhoneNumbers(id);

      for (const phoneNumber of phoneNumbers) {
        try {
          await unassignPhoneNumberFromApp(phoneNumber.phone_number_id);
          console.log(
            `[API] Unassigned phone number ${phoneNumber.phone_number} from flow ${id}`
          );
        } catch (error) {
          console.error(
            `[API] Failed to unassign phone number ${phoneNumber.phone_number_id}:`,
            error
          );
          // Continue with other phone numbers even if one fails
        }
      }

      // Delete Telnyx Voice Application
      try {
        await deleteVoiceApplication(flow.telnyx_voice_app_id);
        console.log(
          `[API] Deleted voice application ${flow.telnyx_voice_app_id} for flow ${id}`
        );
      } catch (error) {
        console.error(
          `[API] Failed to delete voice application ${flow.telnyx_voice_app_id}:`,
          error
        );
        // Continue with flow deletion even if voice app deletion fails
      }
    }

    // Delete flow from database (cascades to phone number assignments)
    const result = await VoiceFlowDb.deleteFlow(id, username);

    if (!result) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      deleted: true,
    });
  } catch (error) {
    console.error("[API] Error deleting flow:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to delete flow" },
      { status: 500 }
    );
  }
}
