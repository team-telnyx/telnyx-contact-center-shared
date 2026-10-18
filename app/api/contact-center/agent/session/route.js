import { authenticateVoiceEndpoint, followComputerSelection } from "@/lib/acd/voice-endpoints.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { heartbeatAgentSession } from "@/lib/acd/sessions.mjs";
import { withPermission } from "@/lib/authz/guard";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";

const voiceLogger = createDiagnosticLogger("acd.voice_endpoints");

async function PUT_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    const body = await request.json();
    const token=request.headers.get('x-cc-endpoint-token');
    const voiceEndpoint=token ? await authenticateVoiceEndpoint(pool,user,token) : null;
    const result = await heartbeatAgentSession(pool, { agentId: String(user.id), sessionId: body.sessionId,
      voiceEndpoint, pushReady: body.pushReady === true, videoPushReady: body.videoPushReady === true, deviceId: body.deviceId, voiceReady: body.voiceReady === true, chatReady: body.chatReady === true, emailReady: body.emailReady === true,
      ready: Object.fromEntries(Object.entries(body.ready && typeof body.ready === "object" ? body.ready : {}).map(([channel, value]) => [channel, value === true])),
      offline: body.offline === true, node: process.env.NODE_ID || "web" });
    // The computer's calls follow its connected tab when the tab holding them is gone. Best effort:
    // the next heartbeat retries, and the heartbeat itself has already been recorded.
    if (voiceEndpoint?.kind === "web") await followComputerSelection(pool, String(user.id))
      .catch(error => voiceLogger.warn("computer_selection_follow_failed", { error: String(error?.message || error).slice(0, 300) }));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) { return NextResponse.json({ error: error.status ? error.message : "Session update failed" }, { status: error.status || 500 }); }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PUT = withPermission("agent:self", PUT_handler, { route: "/api/contact-center/agent/session" });
