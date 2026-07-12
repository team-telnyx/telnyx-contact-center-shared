import { NextResponse } from "next/server";
import { requireAiApiKey } from "@/app/api/_utils/ai-auth";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks";
import {
  buildContactDynamicVariablesResponse,
  clampContactMemoryLimit,
  extractDynamicVariablesTarget,
  normalizeContactTarget,
} from "@/lib/ai/contact-dynamic-variables.mjs";
import { platformApiLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

export async function POST(request, { params }) {
  const rawBody = await request.text();
  const apiKeyValid = requireAiApiKey(request).ok;
  const signatureValid = await verifyTelnyxSignature(request, rawBody);
  if (!apiKeyValid && !signatureValid) {
    return NextResponse.json(
      { error: "Unauthorized", dynamic_variables: {} },
      { status: 401 }
    );
  }

  try {
    const body = JSON.parse(rawBody || "{}");
    const target = extractDynamicVariablesTarget(body);
    if (!target) {
      return NextResponse.json(
        { error: "Invalid assistant.initialization payload", dynamic_variables: {} },
        { status: 400 }
      );
    }

    const resolvedParams = await params;
    const limit = clampContactMemoryLimit(resolvedParams?.limit);
    const normalized = normalizeContactTarget(target);
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured", dynamic_variables: {} },
        { status: 500 }
      );
    }

    const { rows } = await pool.query(
      `SELECT *
         FROM contacts
        WHERE deleted_at IS NULL
          AND (
            ($1 <> '' AND (
              regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
              OR regexp_replace(COALESCE(mobile, ''), '[^0-9]', '', 'g') = $1
              OR regexp_replace(COALESCE(business_phone_1, ''), '[^0-9]', '', 'g') = $1
              OR regexp_replace(COALESCE(business_phone_2, ''), '[^0-9]', '', 'g') = $1
              OR regexp_replace(COALESCE(home_phone_1, ''), '[^0-9]', '', 'g') = $1
              OR regexp_replace(COALESCE(home_phone_2, ''), '[^0-9]', '', 'g') = $1
            ))
            OR ($2 <> '' AND (
              LOWER(COALESCE(email_address_1, '')) = $2
              OR LOWER(COALESCE(email_address_2, '')) = $2
            ))
          )
        ORDER BY updated_at DESC
        LIMIT 1`,
      [normalized.digits, normalized.email]
    );

    return NextResponse.json(
      buildContactDynamicVariablesResponse({
        contact: rows?.[0] || null,
        target: normalized.raw,
        limit,
      })
    );
  } catch (error) {
    platformApiLogger.error("contact_dynamic_variables_failed", {
      ...runtimePayload({ error }),
    });
    return NextResponse.json(
      { error: "Failed to resolve contact", dynamic_variables: {} },
      { status: 500 }
    );
  }
}
