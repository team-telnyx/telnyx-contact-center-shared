import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getPublishedWidget } from "@/lib/widgets/store.js";
import { isWidgetOriginAllowed, widgetTestOrigin } from "@/lib/widgets/config.js";
import { verifyWidgetBootstrapToken, widgetAdmissionKey } from "@/lib/widgets/session-tokens.js";
import { issuePairing } from "@/lib/cobrowse/lifecycle.mjs";
import { corsHeaders, requestOrigin } from "@/lib/cobrowse/http.mjs";

async function handle(request, context) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  const { publicId } = await context.params;
  const origin = requestOrigin(request);
  if (!origin) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const widget = await getPublishedWidget(pool, publicId);
  if (!widget?.config.cobrowse?.enabled || !widget.config.cobrowse.entryPoints.pairingCode ||
    !(isWidgetOriginAllowed(origin, widget.config.allowedOrigins) || origin === new URL(request.url).origin))
    return NextResponse.json({ error: "Co-browsing unavailable" }, { status: 403 });
  const headers = corsHeaders(origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (Number(request.headers.get("content-length") || 0) > 4096) return NextResponse.json({ error: "Request too large" }, { status: 413, headers });
  try {
    const body = await request.json().catch(() => ({}));
    const claims = verifyWidgetBootstrapToken(body.bootstrapToken, { publicId });
    const storedOrigin = claims.org === origin ? origin : claims.org === widgetTestOrigin(origin) ? claims.org : null;
    if (!storedOrigin) return NextResponse.json({ error: "Origin mismatch" }, { status: 403, headers });
    const result = await issuePairing(pool, { publicId, bootstrapToken: body.bootstrapToken,
      origin: storedOrigin, admissionKey: widgetAdmissionKey(request) });
    return NextResponse.json(result, { headers });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "Pairing unavailable" },
      { status: error.status || 500, headers });
  }
}

export const POST = handle;
export const OPTIONS = handle;
