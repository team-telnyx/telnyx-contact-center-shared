import { NextResponse } from "next/server";
import { withWidgetAdmin } from "@/lib/widgets/admin-api";
import { deleteVideoMedia } from "@/lib/video/media-library.mjs";

async function handle(request, context) {
  return withWidgetAdmin(request, async ({ pool }) => {
    const { mediaId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaId || "")) return NextResponse.json({ error: "Invalid media id" }, { status: 400 });
    return NextResponse.json({ deleted: await deleteVideoMedia(pool, mediaId) });
  }, { permission: "widgets:update" });
}
export const DELETE = handle;
