import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { recordingInScope, selfOnlyScope } from "@/lib/authz/scope.mjs";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { defaultRoomsClient } from "@/lib/video/rooms.mjs";

const CONTENT_TYPES = { mp4: "video/mp4", webm: "video/webm", ogg: "audio/ogg", opus: "audio/ogg" };

// Streams a Telnyx Video Rooms composition (default) or a per-participant
// recording. Download links expire after an hour, so a fresh link is fetched on
// every request and proxied with byte-range support for the player.
async function GET_handler(request, { params }, authz) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ ok: false, error: "recording id is required" }, { status: 400 });
    const kind = new URL(request.url).searchParams.get("kind") === "recording" ? "recording" : "composition";
    const recordingScope = authz.can("recordings:read") ? authz.scope : selfOnlyScope(authz.user);
    if (!(await recordingInScope(getPostgresPool(), recordingScope, { recordingId: id }))) {
      return NextResponse.json({ ok: false, error: "Recording outside your data scope" }, { status: 403 });
    }
    const rooms = defaultRoomsClient();
    const artefact = kind === "composition" ? await rooms.getComposition(id) : await rooms.getRecording(id);
    if (!artefact?.download_url || artefact.status !== "completed") {
      return NextResponse.json({ ok: false, error: "Recording is still processing" }, { status: 409 });
    }
    const rangeHeader = request.headers.get("range");
    const upstream = await fetch(artefact.download_url, rangeHeader ? { headers: { Range: rangeHeader } } : {});
    if (!upstream.ok) return NextResponse.json({ ok: false, error: "Failed to fetch recording file" }, { status: 502 });
    const format = kind === "composition" ? "mp4" : (artefact.codec === "opus" ? "ogg" : artefact.type === "video" ? "webm" : "ogg");
    const headers = {
      "Content-Type": upstream.headers.get("content-type")?.startsWith("video/") || upstream.headers.get("content-type")?.startsWith("audio/")
        ? upstream.headers.get("content-type") : CONTENT_TYPES[format] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=600",
    };
    for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    return new NextResponse(upstream.body, { status: rangeHeader && upstream.status === 206 ? 206 : 200, headers });
  } catch (error) {
    contactCenterRuntimeLogger.error("video_recording_stream_failed", { ...runtimePayload({ error }) });
    return NextResponse.json({ ok: false, error: error.status === 404 ? "Recording not found" : "Failed to stream recording" }, { status: error.status === 404 ? 404 : 500 });
  }
}

export const GET = withPermission(["recordings:read", "agent:self"], GET_handler, { route: "/api/video/recordings/[id]/stream" });
