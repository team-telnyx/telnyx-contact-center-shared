import { NextResponse } from "next/server";
import { listMediaFiles } from "@/lib/media-storage";
import { platformApiLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

export async function GET(request) {
  try {
    const baseUrl =
      process.env.APP_BASE_URL ||
      process.env.NEXTAUTH_URL ||
      new URL(request.url).origin;
    const audioFiles = await listMediaFiles("audio", { baseUrl });

    return NextResponse.json({
      success: true,
      files: audioFiles,
    });
  } catch (error) {
    platformApiLogger.error("audio_media_list_failed", {
      ...runtimePayload({ error }),
    });
    return NextResponse.json(
      { success: false, error: "Failed to list audio files" },
      { status: 500 }
    );
  }
}
