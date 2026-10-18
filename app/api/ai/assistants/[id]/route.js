import { validateAssistantVisionTools } from "@/lib/ai/vision-validation.mjs";
import { validateConversationFlow } from "@/lib/ai/assistant-conversation-workflow.mjs";
import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { verifyAssistantWrite } from "@/lib/ai/assistant-verification.mjs";
import { normalizeAssistantPayload, assistantUpdateWirePayload } from "@/lib/ai/assistant-payload.mjs";
import { telnyxErrorDetail } from "@/lib/telnyx-error.mjs";
import { hasVoiceAudioConflict } from "@/lib/ai/assistant-audio-ui.mjs";
import { assistantSaveErrorMessage } from "@/lib/ai/assistant-save-feedback.mjs";
import {
  fetchAssistant,
  fetchLibraryToolIds,
  planAssistantToolSave,
} from "@/lib/ai/shared-tool-sync.mjs";

import { withPermission } from "@/lib/authz/guard";
export const dynamic = "force-dynamic";

// GET single assistant
async function GET_handler(request, { params }) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { id } = await params;

    const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${id}`), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: telnyxErrorDetail(text, `Telnyx API error: ${res.status}`) },
        { status: [400, 404, 422].includes(res.status) ? res.status : 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    return NextResponse.json(
      { ok: true, assistant: data?.data || data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: err.status || 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// PUT update assistant (forwards as POST to Telnyx - their API uses POST for updates)
async function PUT_handler(request, { params }) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { id } = await params;
    const normalized = normalizeAssistantPayload(await request.json().catch(() => ({})));

    if (normalized.conversation_flow) {
      const errors = validateConversationFlow(normalized.conversation_flow, {allowInheritedInstructions: true});
      if (errors.length) return NextResponse.json({ok: false, error: errors.join(" "), code: "invalid_workflow"}, {status: 400, headers: {"Cache-Control": "no-store"}});
    }

    // Shared (Tools Library) tools come back from Telnyx inside `tools` and
    // must not be sent back inline: Telnyx would create a second webhook tool
    // with the same name next to the attachment. They are attached and
    // replaced atomically through tool_ids in the same version update.
    let payload = normalized;
    let attachments = null;
    const [current, libraryToolIds] = await Promise.all([
      fetchAssistant(apiKey, id),
      Array.isArray(normalized.tools) ? fetchLibraryToolIds(apiKey) : Promise.resolve(new Set()),
    ]);
    if (normalized.voice_settings && hasVoiceAudioConflict({ ...current?.voice_settings, ...normalized.voice_settings })) {
      return NextResponse.json({ ok: false, error: assistantSaveErrorMessage("voice_settings.tool_call_audio conflicts with voice_settings.background_audio"), code: "assistant_audio_conflict" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (Array.isArray(normalized.tools)) {
      const plan = planAssistantToolSave(normalized, { currentTools: current?.tools, libraryToolIds });
      if (plan.duplicateNames.length) {
        return NextResponse.json(
          {
            ok: false,
            error: `Webhook tool names must be unique within an assistant; rename or remove the duplicates: ${plan.duplicateNames.join(", ")}`,
            duplicateToolNames: plan.duplicateNames,
          },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      payload = {...plan.updatePayload, tool_ids:[...plan.desiredSharedToolIds]};
      attachments = { currentToolIds: plan.currentSharedToolIds, desiredToolIds: plan.desiredSharedToolIds };
    }

    await validateAssistantVisionTools({...current, ...payload});
    const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${id}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(assistantUpdateWirePayload(payload)),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: telnyxErrorDetail(text, `Telnyx API error: ${res.status}`) },
        { status: [400, 404, 422].includes(res.status) ? res.status : 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    let data = await res.json();
    const saved = data?.data || data;
    const expected = {...payload, ...(attachments ? {tool_ids:[...attachments.desiredToolIds]} : {})};
    const checked = await verifyAssistantWrite(apiKey, id, expected, {previousAssistant: current, versionId: payload.promote_to_main === false ? saved.version_id : undefined});
    return NextResponse.json(
      { ok: true, assistant: checked.assistant || saved, verification: checked.verification },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: err.status || 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Telnyx uses POST for assistant updates; keep PUT for the contact-center
// editor and expose POST for demo-portal components such as WidgetTab.
async function POST_handler(request, context) {
  return PUT(request, context);
}

// DELETE assistant
async function DELETE_handler(request, { params }) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { id } = await params;

    const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${id}`), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: telnyxErrorDetail(text, `Telnyx API error: ${res.status}`) },
        { status: [400, 404, 422].includes(res.status) ? res.status : 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: err.status || 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("ai_assistants:read", GET_handler, { route: "/api/ai/assistants/[id]" });
export const POST = withPermission("ai_assistants:update", POST_handler, { route: "/api/ai/assistants/[id]" });
export const PUT = withPermission("ai_assistants:update", PUT_handler, { route: "/api/ai/assistants/[id]" });
export const DELETE = withPermission("ai_assistants:delete", DELETE_handler, { route: "/api/ai/assistants/[id]" });
