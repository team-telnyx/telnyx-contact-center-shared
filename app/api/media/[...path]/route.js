import { NextResponse } from "next/server";
import path from "path";
import { getStorage } from "@/lib/storage/index.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

const CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
]);

/**
 * Waliduje segmenty sciezki i zwraca bezpieczna nazwe pliku. Uploady to plaska
 * przestrzen nazw (/media/<filename>), wiec bierzemy ostatni segment. Storage
 * drivery dodatkowo kotwicza odczyt w swoim katalogu/prefiksie.
 */
function resolveFilename(parts = []) {
  const cleanParts = parts.map((part) => String(part || "")).filter(Boolean);
  if (!cleanParts.length || cleanParts.some((part) => part.includes("..") || part.includes("/") || part.includes("\\"))) return null;
  return cleanParts[cleanParts.length - 1];
}

async function serveMedia(paramsPromise) {
  const params = await paramsPromise;
  const filename = resolveFilename(params?.path || []);
  if (!filename) return new NextResponse("Not Found", { status: 404 });

  const ext = path.extname(filename).toLowerCase();
  const contentType = CONTENT_TYPES.get(ext);
  if (!contentType) return new NextResponse("Not Found", { status: 404 });

  try {
    const storage = await getStorage();
    const obj = await storage.get(filename, contentType);
    if (!obj) return new NextResponse("Not Found", { status: 404 });
    return new NextResponse(obj.body, {
      status: 200,
      headers: {
        "Content-Type": obj.contentType || contentType,
        "Content-Length": String(obj.size ?? obj.body?.length ?? 0),
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
  const filename = resolveFilename(resolvedParams?.path || []);
  if (!filename) return new NextResponse(null, { status: 404 });
  const ext = path.extname(filename).toLowerCase();
  const contentType = CONTENT_TYPES.get(ext);
  if (!contentType) return new NextResponse(null, { status: 404 });
  try {
    const storage = await getStorage();
    const head = await storage.head(filename);
    if (!head) return new NextResponse(null, { status: 404 });
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(head.size ?? 0),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    if (err?.code === "ENOENT") return new NextResponse(null, { status: 404 });
    return new NextResponse(null, { status: 500 });
  }
}
