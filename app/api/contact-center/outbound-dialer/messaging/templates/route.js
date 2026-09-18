import { NextResponse } from "next/server";
import { getOutboundPool, jsonError } from "@/lib/outbound-dialer/api";
import { OUTBOUND_MESSAGING_CHANNELS } from "@/lib/outbound-dialer/schema";
import { listMessagingTemplates } from "@/lib/outbound-dialer/messaging/templates.mjs";
import { withPermission } from "@/lib/authz/guard";

// Template descriptors for the campaign editor: one shape for every channel.
async function GET_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { searchParams } = new URL(request.url);
  const channel = String(searchParams.get("channel") || "sms").toLowerCase();
  if (!OUTBOUND_MESSAGING_CHANNELS.includes(channel)) return jsonError("Unsupported messaging channel", 400);
  const templates = await listMessagingTemplates(pool, channel, { includeArchived: searchParams.get("status") === "all" });
  return NextResponse.json({ ok: true, channel, templates });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("campaigns:read", GET_handler, { route: "/api/contact-center/outbound-dialer/messaging/templates" });
