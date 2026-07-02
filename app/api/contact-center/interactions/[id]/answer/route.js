import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PgDb } from "@/lib/pgdb";
import { bridgeCallToAgent } from "@/lib/contact-center/webrtc-bridge";
import { broadcastToKey } from "@/lib/sse";
import { interactionsLogger, callPayload, agentPayload, contactCenterErrorPayload } from "@/lib/contact-center/logging.mjs";

/**
 * POST /api/contact-center/interactions/:id/answer
 * Answer an incoming interaction (bridge to agent's WebRTC client)
 */
export async function POST(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { id } = await params;
    const interaction = await PgDb.findInteractionById(id);

    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 }
      );
    }

    // Check if interaction is in a state that can be answered/picked up
    if (!["queued", "ringing"].includes(interaction.state)) {
      return NextResponse.json(
        {
          ok: false,
          error: `Cannot answer interaction in state: ${interaction.state}`,
        },
        { status: 400 }
      );
    }

    // For shared queues, verify agent is activated in the queue
    // For private queues, verify agent owns the queue
    const { resolveQueueName } = await import(
      "@/lib/contact-center/queue-utils.js"
    );
    const resolved = resolveQueueName(interaction.queue_name, user.username);

    if (resolved.type === "shared") {
      // Check if agent is activated in this shared queue
      const assignments = await PgDb.listAgentQueueAssignments(user.username);
      const isActivated = assignments.some(
        (a) => a.queue_id === interaction.queue_id && a.enabled
      );
      if (!isActivated) {
        return NextResponse.json(
          { ok: false, error: "You are not activated in this queue" },
          { status: 403 }
        );
      }
    } else if (resolved.type === "private") {
      // For private queues, verify the agent owns it
      if (resolved.owner !== user.username) {
        return NextResponse.json(
          { ok: false, error: "Not authorized to answer this interaction" },
          { status: 403 }
        );
      }
    }

    // Transfer call to agent's WebRTC client
    if (
      interaction.interaction_type === "voice" &&
      interaction.call_control_id &&
      interaction.call_session_id
    ) {
      try {
        // Lookup contact by caller's phone number
        let fromDisplayName = null;
        if (interaction.from_number) {
          try {
            interactionsLogger.debug("interaction_diagnostic_0", {});
            // Use findContactByPhoneNumber which checks all phone columns
            const contact = await PgDb.findContactByPhoneNumber(
              interaction.from_number
            );
            if (contact) {
              interactionsLogger.debug("interaction_diagnostic_1", {});

              // Prefer display_name if available, otherwise use first_name + last_name
              if (contact.display_name) {
                fromDisplayName = contact.display_name;
              } else if (contact.first_name && contact.last_name) {
                fromDisplayName = `${contact.first_name} ${contact.last_name}`;
              } else if (contact.first_name) {
                fromDisplayName = contact.first_name;
              } else if (contact.last_name) {
                fromDisplayName = contact.last_name;
              }

              if (fromDisplayName) {
                interactionsLogger.debug("interaction_diagnostic_2", {});
              } else {
                interactionsLogger.warn("interaction_warning_3", {});
              }
            } else {
              interactionsLogger.debug("interaction_diagnostic_4", {});
            }
          } catch (err) {
            // Contacts table might not exist, that's okay
            interactionsLogger.error("interaction_error_5", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
          }
        } else {
          interactionsLogger.debug("interaction_diagnostic_6", {});
        }

        const bridgeResult = await bridgeCallToAgent(
          interaction.call_session_id,
          interaction.call_control_id,
          user.username,
          interaction.from_number, // Caller's number (FROM field)
          fromDisplayName // Customer name if found
        );

        // Update interaction state and assign to agent
        // NOTE: We set assignedAt here (when agent picks up), but NOT answeredAt
        // The answeredAt will be set by the call.answered webhook when the agent actually answers the WebRTC call
        await PgDb.updateInteractionById(id, {
          agentUsername: user.username, // Assign to the agent picking up
          state: "ringing", // Will change to "connected" when WebRTC call is answered
          assignedAt: new Date().toISOString(), // Set when agent picks up (for wait_time calculation)
        });

        // Notify via SSE
        broadcastToKey(`contact-center:agent:${user.username}`, {
          type: "interaction_answered",
          interactionId: id,
          agentCallControlId: bridgeResult.agentCallControlId,
        });

        return NextResponse.json({
          ok: true,
          agentCallControlId: bridgeResult.agentCallControlId,
        });
      } catch (err) {
        interactionsLogger.error("interaction_error_7", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
        return NextResponse.json(
          { ok: false, error: err.message || "Failed to bridge call" },
          { status: 500 }
        );
      }
    } else {
      // For non-voice interactions, just update state
      await PgDb.updateInteractionById(id, {
        state: "connected",
        answeredAt: new Date().toISOString(),
      });

      return NextResponse.json({ ok: true });
    }
  } catch (err) {
    interactionsLogger.error("interaction_error_8", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}
