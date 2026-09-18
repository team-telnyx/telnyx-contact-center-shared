import { NextResponse } from "next/server";
import { withWidgetAdmin } from "@/lib/widgets/admin-api";
import { boundedMultipart } from "@/lib/widgets/attachments";
import { MAX_VIDEO_MEDIA_BYTES, listVideoMedia, storeVideoMedia } from "@/lib/video/media-library.mjs";

// Video media library for the widget's waiting playlist (Widget Studio → Video).
async function handle(request) {
  return withWidgetAdmin(request, async ({ pool, actor }) => {
    if (request.method === "GET") return NextResponse.json({ media: await listVideoMedia(pool) }, { headers: { "Cache-Control": "no-store" } });
    let file;
    try { file = (await boundedMultipart(request, MAX_VIDEO_MEDIA_BYTES)).get("file"); }
    catch (error) { if (error.status) throw error; return NextResponse.json({ error: "The upload could not be read; send one mp4 or webm file up to 64 MB" }, { status: 400 }); }
    if (!file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "Upload an mp4 or webm video up to 64 MB" }, { status: 400 });
    const media = await storeVideoMedia(pool, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()), actor });
    return NextResponse.json({ media }, { status: 201 });
  }, { permission: "widgets:update" });
}
export const GET = handle;
export const POST = handle;
