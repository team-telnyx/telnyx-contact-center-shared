import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readVideoMedia, videoMediaResponse } from "@/lib/video/media-library.mjs";

// Waiting-playlist video for the visitor's widget. Public by design (the
// widget runs on the customer's page without a session); files are reachable
// only by their unguessable id and carry no customer data.
export async function GET(request, context) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await context.params;
  const media = await readVideoMedia(pool, id, { rangeHeader: request.headers.get("range") });
  if (!media) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  return videoMediaResponse(media);
}
