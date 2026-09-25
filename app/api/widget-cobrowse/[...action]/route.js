import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { bearerToken } from "@/lib/widgets/session-tokens.js";
import { corsHeaders, matchStoredOrigin, requestOrigin } from "@/lib/cobrowse/http.mjs";
import { cobrowseSocketUrl } from "@/lib/cobrowse/socket-url.mjs";
import {
  cancelPairing, consentBrowserCobrowse, decideBrowserControl, issuePublisherTicket, readBrowserCobrowse,
  readPairing, stopBrowserCobrowse,
} from "@/lib/cobrowse/lifecycle.mjs";

async function handle(request, context) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  const { action } = await context.params;
  const [resource, id, command] = action;
  if (!id || action.length > 3 || !["pairings", "sessions"].includes(resource))
    return NextResponse.json({ error: "Unknown operation" }, { status: 404 });
  const origin = requestOrigin(request);
  if (!origin) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  // Preflight can inspect the stored origin but never discloses a credential.
  const table = resource === "pairings" ? "acd_cobrowse_pairings" : "acd_cobrowse_sessions";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Invalid identifier" }, { status: 400 });
  const row = (await pool.query(`SELECT origin FROM ${table} WHERE id=$1`, [id])).rows[0];
  const storedOrigin = matchStoredOrigin(row?.origin, origin);
  if (!storedOrigin) return NextResponse.json({ error: "Origin mismatch" }, { status: 403 });
  const headers = corsHeaders(origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const credential = bearerToken(request);
  if (Number(request.headers.get("content-length") || 0) > 2048)
    return NextResponse.json({ error: "Request too large" }, { status: 413, headers });
  try {
    if (resource === "pairings" && !command && request.method === "GET")
      return NextResponse.json(await readPairing(pool, { pairingId: id, credential, origin: storedOrigin }), { headers });
    if (resource === "pairings" && command === "cancel" && request.method === "POST")
      return NextResponse.json(await cancelPairing(pool, { pairingId: id, credential, origin: storedOrigin }), { headers });
    if (resource === "sessions" && !command && request.method === "GET")
      return NextResponse.json({ session: await readBrowserCobrowse(pool, { sessionId: id, credential, origin: storedOrigin }) }, { headers });
    if (resource === "sessions" && command === "consent" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (typeof body.accepted !== "boolean") return NextResponse.json({ error: "Decision required" }, { status: 400, headers });
      return NextResponse.json(await consentBrowserCobrowse(pool, { sessionId: id, credential, origin: storedOrigin, accepted: body.accepted }), { headers });
    }
    if (resource === "sessions" && command === "control" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!["accept", "decline", "revoke"].includes(body.decision)) return NextResponse.json({ error: "Invalid decision" }, { status: 400, headers });
      return NextResponse.json({ session: await decideBrowserControl(pool, { sessionId: id, credential, origin: storedOrigin, decision: body.decision }) }, { headers });
    }
    if (resource === "sessions" && command === "token" && request.method === "POST")
      return NextResponse.json({ ...(await issuePublisherTicket(pool, { sessionId: id, credential, origin: storedOrigin })), wsUrl: cobrowseSocketUrl(request.url) }, { headers });
    if (resource === "sessions" && command === "stop" && request.method === "POST")
      return NextResponse.json({ session: await stopBrowserCobrowse(pool, { sessionId: id, credential, origin: storedOrigin }) }, { headers });
    return NextResponse.json({ error: "Unknown operation" }, { status: 404, headers });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "Request failed" },
      { status: error.status || 500, headers });
  }
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
