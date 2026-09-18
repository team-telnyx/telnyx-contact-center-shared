import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { requestOutboundDial } from "@/lib/acd/outbound-runtime.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

function usernameFor(user) {
  return user?.username || user?.email || null;
}

async function POST_handler(request, _context, authz) {
  try {
    const user = authz.user;
    const agentUsername = usernameFor(user);
    if (!agentUsername) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const body = await request.json().catch(() => ({}));
    const attemptId = String(body?.attemptId || "").trim();
    if (!attemptId) return NextResponse.json({ ok: false, error: "Attempt ID is required" }, { status: 400 });
    const execution = await requestOutboundDial(pool, { attemptId, agentId: String(user.id) });
    return NextResponse.json({ ok: execution?.ok === true, execution });
  } catch (err) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: 400 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { route: "/api/contact-center/agent/campaigns/dial" });
