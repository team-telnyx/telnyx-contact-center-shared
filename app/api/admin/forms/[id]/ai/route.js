import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { applyFormOperations, validateFormOperations } from "@/lib/forms/form-operations";

function deterministicOperations(prompt = "") {
  const text = prompt.toLowerCase();
  if (text.includes("email")) return [{ type: "addField", field: { id: "email", type: "text", label: "Email", required: text.includes("required") } }];
  if (text.includes("queue")) return [{ type: "setQueueAssignment", queue_names: [prompt.match(/queue\s+([A-Za-z0-9 _-]+)/i)?.[1]?.trim() || "Sales"], auto_open: text.includes("auto") }];
  return [{ type: "addField", field: { id: `field_${Date.now()}`, type: "text", label: "New field", required: false } }];
}

export async function POST(request) {
  const session = await getServerSession(authOptions); if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json(); const prompt = body.prompt || ""; const currentForm = body.currentForm || body.form || {};
  const apiKey = process.env.TELNYX_API_KEY || process.env.TELNYX_CHAT_API_KEY;
  let operations = [];
  let ai = { used: false, reason: "TELNYX_API_KEY/TELNYX_CHAT_API_KEY not configured; returned deterministic MVP operation scaffold." };
  if (apiKey && process.env.FORM_BUILDER_AI_LIVE === "true") {
    ai = { used: false, reason: "Live Telnyx Chat Completion integration is scaffolded but gated off until the project helper/model contract is finalized." };
  }
  operations = deterministicOperations(prompt);
  const opValidation = validateFormOperations(operations); const result = opValidation.ok ? applyFormOperations(currentForm, operations) : { form: currentForm, validation: opValidation };
  return NextResponse.json({ ok: opValidation.ok && result.validation.ok, operations, form: result.form, validation: result.validation, ai });
}
