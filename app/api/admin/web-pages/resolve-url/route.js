import { NextResponse } from "next/server";
import { resolveSimpleSecretReferences } from "@/lib/secrets";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


/**
 * POST /api/admin/web-pages/resolve-url
 * Resolves {{secret}} placeholders in a URL and returns the resolved URL
 * Only accessible by admins
 */
async function POST_handler(request, _context, authz) {
  const user = authz.user;

  try {
    const body = await request.json();
    const { url } = body;

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    // Resolve secret placeholders
    const resolvedUrl = await resolveSimpleSecretReferences(url);

    // Validate the resolved URL
    try {
      new URL(resolvedUrl);
    } catch {
      return NextResponse.json({ error: "Invalid URL after resolving secrets" }, { status: 400 });
    }

    return NextResponse.json({ resolvedUrl });
  } catch (err) {
    const msg = err?.message || String(err);
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("web_pages:create", POST_handler, { route: "/api/admin/web-pages/resolve-url" });
