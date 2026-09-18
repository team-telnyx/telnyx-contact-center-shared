import { NextResponse } from "next/server";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { generateExpressivePreviewSample, normalizePersona } from "@/lib/call-generator/workflow-testing.mjs";
import { withPermission } from "@/lib/authz/guard";


// Generate an Expressive Mode preview sample sentence (≤20 words) for the given
// persona + voice. When Expressive Mode is on and the voice supports it
// (Telnyx Ultra / xAI Grok), the sentence carries the matching inline tags so
// the admin can Play it and hear the persona + expression.
async function POST_handler(request, _context, authz) {
  const user = authz.user;
  try {
    const body = await request.json();
    const persona = normalizePersona(body?.persona);
    const voice = String(body?.voice || "").trim();
    const expressive = body?.expressive === true;
    const sample = await generateExpressivePreviewSample({ persona, voice, expressive });
    if (!sample) return NextResponse.json({ error: "Empty sample" }, { status: 502 });
    return NextResponse.json({ sample });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_preview_sample_failed", runtimePayload({ error: err, operation: "cg_preview_sample" }));
    return NextResponse.json({ error: "Failed to generate preview sample" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("call_generator:read", POST_handler, { route: "/api/admin/call-generator/preview-sample" });
