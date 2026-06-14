import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { generateExpressivePreviewSample, normalizePersona } from "@/lib/call-generator/workflow-testing.mjs";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

// Generate an Expressive Mode preview sample sentence (≤20 words) for the given
// persona + voice. When Expressive Mode is on and the voice supports it
// (Telnyx Ultra / xAI Grok), the sentence carries the matching inline tags so
// the admin can Play it and hear the persona + expression.
export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
