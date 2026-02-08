import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getAuthenticatedUser } from "@/lib/auth-server";

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const channelFilter = searchParams.get("channel"); // Filter by channel (SMS/MMS)

    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10))
    );
    const qTo = (searchParams.get("to") || "").trim();
    const qFrom = (searchParams.get("from") || "").trim();
    const qDirection = (searchParams.get("direction") || "").trim();
    const qStatus = (searchParams.get("status") || "").trim();
    const qText = (searchParams.get("q") || "").trim();
    
    const filter = { username: user.username };
    if (channelFilter) filter.channel = channelFilter;
    if (qTo) filter.to = qTo;
    if (qFrom) filter.from = qFrom;
    if (qDirection) filter.direction = qDirection;
    if (qStatus) filter.status = qStatus;
    if (qText) filter.body = { $ilike: `%${qText.replace(/%/g, "%%")}%` };

    const { rows, count } = await PgDb.findMessages(filter, { page, pageSize });
    const items = rows.map((r) => ({
      id: r.id,
      username: r.username,
      channel: r.channel,
      direction: r.direction,
      status: r.status,
      to: r.to,
      from: r.from,
      body: r.body,
      mediaUrls: r.media_urls || [],
      telnyxMessageId: r.telnyx_message_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    const total = count;
    return NextResponse.json({ page, pageSize, total, items });
  } catch (err) {
    console.error("Error in /api/messaging/history:", err);
    return NextResponse.json(
      { error: "Server error", details: err.message },
      { status: 500 }
    );
  }
}
