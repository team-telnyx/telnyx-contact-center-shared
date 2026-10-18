import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { widgetAiRequest } from "@/lib/widgets/ai-provider";
import { assistantCallSocketUrl, issueAssistantCallSession, WORKFLOW_TEST_SCOPE } from "@/lib/ai/assistant-call-session.mjs";

/**
 * POST /api/admin/workflows/[id]/voice-test-session
 *
 * Issues a short-lived, workflow-scoped capability for the "Test AI Agent"
 * voice channel. The browser presents it to the authenticated assistant call
 * relay (/assistant-call on the streaming sidecar), which opens the Telnyx
 * conversation WebSocket with the account API key. The token never contains
 * Telnyx credentials, is bound to this origin, and is re-checked by the relay
 * during the call (user permission and workflow → assistant binding).
 */
const headers = { "Cache-Control": "no-store" };

export const POST = withPermission("workflows:ai", async (request, context, authz) => {
  const origin = request.headers.get("origin") || new URL(request.url).origin;
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  const allowedOrigins = [requestUrl.origin, ...(host ? [`${requestUrl.protocol}//${host}`] : []), ...(process.env.NEXTAUTH_URL ? [new URL(process.env.NEXTAUTH_URL).origin] : [])];
  if (!allowedOrigins.includes(origin)) return NextResponse.json({ error: "Open Test AI Agent from Contact Center." }, { status: 403, headers });

  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Database not configured" }, { status: 503, headers });
  const { id } = await context.params;
  const { rows: [workflow] } = await pool.query("SELECT id, name, ai_assistant_id FROM aa_workflows WHERE id = $1", [id]);
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404, headers });
  if (!workflow.ai_assistant_id) return NextResponse.json({ error: "Assign an AI assistant to this workflow before running a voice test." }, { status: 400, headers });

  try {
    const response = await widgetAiRequest(`/ai/assistants/${encodeURIComponent(workflow.ai_assistant_id)}`);
    const assistant = response.data || response;
    const token = issueAssistantCallSession({
      userId: String(authz.user.id),
      sessionId: authz.user.authSessionId || null,
      sessionKind: request.headers.has("authorization") ? "bearer" : "web",
      assistantId: assistant.id,
      avatar: null,
      origin,
      scope: WORKFLOW_TEST_SCOPE,
      workflowId: workflow.id,
    });
    return NextResponse.json({
      // A page on localhost uses this machine's relay, not WS_BASE_URL.
      url: assistantCallSocketUrl(request.url, process.env, { pageOrigin: origin }),
      token,
      authentication: "assistant.call.authenticate",
      avatarEnabled: false,
      assistantId: assistant.id,
      assistantName: assistant.name,
    }, { headers });
  } catch (error) {
    // widgetAiRequest reports provider failures as 502 and keeps Telnyx's own
    // status in providerStatus.
    const notFound = error.providerStatus === 404 || error.status === 404;
    return NextResponse.json(
      { error: notFound ? "The assistant assigned to this workflow no longer exists in Telnyx." : "Could not authorize the voice test. Check the Contact Center Telnyx connection and try again." },
      { status: notFound ? 404 : 502, headers },
    );
  }
}, { route: "/api/admin/workflows/[id]/voice-test-session" });
