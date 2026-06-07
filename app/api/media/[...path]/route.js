import { NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import path from "path";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

const MEDIA_DIR = path.join(process.cwd(), "public", "media");
const CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
]);

function resolveMediaPath(parts = []) {
  const cleanParts = parts.map((part) => String(part || "")).filter(Boolean);
  if (!cleanParts.length || cleanParts.some((part) => part.includes("..") || part.includes("/") || part.includes("\\"))) return null;
  const fullPath = path.join(MEDIA_DIR, ...cleanParts);
  return fullPath.startsWith(MEDIA_DIR) ? fullPath : null;
}

async function serveMedia(paramsPromise) {
  const params = await paramsPromise;
  const fullPath = resolveMediaPath(params?.path || []);
  if (!fullPath) return new NextResponse("Not Found", { status: 404 });

  const ext = path.extname(fullPath).toLowerCase();
  const contentType = CONTENT_TYPES.get(ext);
  if (!contentType) return new NextResponse("Not Found", { status: 404 });

  try {
    const [file, fileStat] = await Promise.all([readFile(fullPath), stat(fullPath)]);
    return new NextResponse(file, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileStat.size),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    if (err?.code === "ENOENT") return new NextResponse("Not Found", { status: 404 });
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

export async function GET(_request, { params }) {
  return serveMedia(params);
}

export async function HEAD(_request, { params }) {
  const resolvedParams = await params;
  const fullPath = resolveMediaPath(resolvedParams?.path || []);
  if (!fullPath) return new NextResponse(null, { status: 404 });
  const ext = path.extname(fullPath).toLowerCase();
  const contentType = CONTENT_TYPES.get(ext);
  if (!contentType) return new NextResponse(null, { status: 404 });
  try {
    const fileStat = await stat(fullPath);
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileStat.size),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    if (err?.code === "ENOENT") return new NextResponse(null, { status: 404 });
    return new NextResponse(null, { status: 500 });
  }
}
