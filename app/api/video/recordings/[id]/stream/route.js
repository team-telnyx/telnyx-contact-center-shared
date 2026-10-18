import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { recordingInScope, selfOnlyScope, workItemInScope } from "@/lib/authz/scope.mjs";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { defaultRoomsClient } from "@/lib/video/rooms.mjs";
import { readPrivateVideoRecording } from "@/lib/video/recording-compositor.mjs";

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
    const pool = getPostgresPool();
    const local = (await pool.query("SELECT provider_metadata,work_item_id FROM acd_recordings WHERE provider='telnyx_video' AND provider_recording_id=$1", [id])).rows[0];
    const standalone = local ? null : (await pool.query(`SELECT a->'metadata' AS provider_metadata,v.work_item_id,v.conference_config->'routing'->>'queueId' AS queue_id
      FROM acd_video_sessions v CROSS JOIN LATERAL jsonb_array_elements(v.artifacts) a WHERE a->>'providerRecordingId'=$1 LIMIT 1`, [id])).rows[0];
    const known = local || standalone;
    const allowed = known ? await workItemInScope(pool, recordingScope, known.work_item_id, {queueId:known.queue_id,channel:'video'})
      : await recordingInScope(pool, recordingScope, {recordingId:id});
    if (!allowed) {
      return NextResponse.json({ ok: false, error: "Recording outside your data scope" }, { status: 403 });
    }
    if (known?.provider_metadata?.storage_key) return readPrivateVideoRecording(known.provider_metadata, request.headers.get("range"));
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
