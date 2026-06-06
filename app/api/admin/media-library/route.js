import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

// GET /api/admin/media-library - List all media files
export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.max(
      1,
      parseInt(searchParams.get("pageSize") || "10", 10)
    );

    const apiKey = getApiKey();
    const url = buildTelnyxV2Url("/media");

    // Fetch media files from Telnyx
    // We'll fetch up to 5 pages (500 items) to cover most use cases
    // For larger libraries, consider implementing server-side filtering
    let allItems = [];
    const maxPages = 5;
    const perPage = 100;

    for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
      const telnyxParams = new URLSearchParams();
      telnyxParams.set("page[number]", String(currentPage));
      telnyxParams.set("page[size]", String(perPage));

      const fullUrl = `${url}?${telnyxParams.toString()}`;

      const response = await fetch(fullUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[Media Library] GET error:", errorText);
        if (currentPage === 1) {
          return NextResponse.json(
            { error: "Failed to fetch media files" },
            { status: response.status }
          );
        }
        break;
      }

      const data = await response.json();
      const items = data.data || [];
      if (items.length === 0) break; // No more items
      allItems = allItems.concat(items);

      // Log for debugging
      if (currentPage === 1) {
        console.log(
          `[Media Library] Fetched ${items.length} items from page ${currentPage}`
        );
      }

      const meta = data.meta || {};
      const totalPages = meta.page?.total_pages || 1;
      if (currentPage >= totalPages) break; // Reached last page
    }

    // Filter to only show audio files (mp3, wav)
    // Check both content_type and file extension as fallback
    // Be permissive to catch all audio formats
    const audioItems = allItems.filter((item) => {
      const contentType = (item.content_type || "").toLowerCase();
      const mediaName = (item.media_name || "").toLowerCase();

      // Check content type - match the same logic as media library page display
      // Check for MIME types and also check for format names (mp3, mpeg, wav)
      // Also check for common audio-related strings
      const isAudioContentType =
        contentType.includes("audio/mpeg") ||
        contentType.includes("audio/mp3") ||
        contentType.includes("audio/wav") ||
        contentType.includes("audio/x-wav") ||
        contentType.includes("audio/wave") ||
        contentType.includes("audio/") ||
        contentType.includes("mpeg") ||
        contentType.includes("mp3") ||
        contentType.includes("wav") ||
        contentType === "mp3" || // Sometimes content_type might just be "MP3"
        contentType === "wav";

      // Fallback: check file extension from media_name
      const hasAudioExtension =
        mediaName.endsWith(".mp3") ||
        mediaName.endsWith(".wav") ||
        mediaName.endsWith(".m4a") ||
        mediaName.endsWith(".ogg");

      // Exclude clearly non-audio types
      const isNonAudio =
        contentType.includes("image/") ||
        contentType.includes("video/") ||
        contentType.includes("text/") ||
        contentType.includes("application/pdf") ||
        contentType.includes("application/json") ||
        contentType.includes("application/xml");

      const isAudio = (isAudioContentType || hasAudioExtension) && !isNonAudio;

      // Log items that are being filtered out for debugging (first few items)
      if (!isAudio && allItems.length <= 10) {
        console.log(
          `[Media Library] Filtered out: ${item.media_name}, content_type: "${
            item.content_type || "none"
          }"`
        );
      }

      return isAudio;
    });

    // Log filtering results for debugging
    console.log(
      `[Media Library] Total items: ${allItems.length}, Audio items: ${audioItems.length}`
    );
    if (allItems.length > 0 && audioItems.length === 0) {
      console.log(
        `[Media Library] Warning: No audio items found. Sample content_types:`,
        allItems
          .slice(0, 3)
          .map((item) => ({ name: item.media_name, type: item.content_type }))
      );
    }

    // Apply pagination to filtered results
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedItems = audioItems.slice(startIndex, endIndex);

    return NextResponse.json({
      items: paginatedItems,
      total: audioItems.length,
      page,
      pageSize,
    });
  } catch (err) {
    console.error("[Media Library] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load media files" },
      { status: 500 }
    );
  }
}

// POST /api/admin/media-library - Upload a media file
export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Validate file type - only allow mp3 and wav
    const allowedTypes = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/wave",
    ];
    const fileType = file.type || "";

    // Also check file extension as fallback
    const fileName = file.name || "";
    const fileExtension = fileName.split(".").pop()?.toLowerCase();
    const isValidExtension = ["mp3", "wav"].includes(fileExtension);

    if (
      !allowedTypes.some((type) => fileType.includes(type)) &&
      !isValidExtension
    ) {
      return NextResponse.json(
        { error: "Only MP3 and WAV files are allowed" },
        { status: 400 }
      );
    }

    // Validate file size (max 20 MB)
    const maxSize = 20 * 1024 * 1024; // 20 MB
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: "File size must be less than 20 MB" },
        { status: 400 }
      );
    }

    // Validate and get media_name
    const mediaName = formData.get("media_name");
    if (mediaName) {
      const nameStr = String(mediaName).trim();
      if (nameStr.length === 0) {
        return NextResponse.json(
          { error: "Media name cannot be empty" },
          { status: 400 }
        );
      }

      // Validate media name format (alphanumeric with dots, dashes, underscores)
      const validPattern = /^[a-zA-Z0-9._-]+$/;
      if (!validPattern.test(nameStr)) {
        return NextResponse.json(
          {
            error:
              "Media name can only contain letters, numbers, dots, dashes, and underscores",
          },
          { status: 400 }
        );
      }

      if (nameStr.length > 255) {
        return NextResponse.json(
          { error: "Media name must be 255 characters or less" },
          { status: 400 }
        );
      }
    }

    const apiKey = getApiKey();
    const url = buildTelnyxV2Url("/media");

    // Create FormData for Telnyx API
    const telnyxFormData = new FormData();
    telnyxFormData.append("media", file);

    // Set TTL to maximum (20 years = 630719999 seconds) - files should never expire
    // Note: API requires value to be less than 630720000, so we use 630719999
    const maxTtl = 630719999;
    telnyxFormData.append("ttl_secs", String(maxTtl));

    // Set media_name if provided
    if (mediaName) {
      telnyxFormData.append("media_name", String(mediaName).trim());
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: telnyxFormData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage =
        errorData?.errors?.[0]?.detail ||
        errorData?.errors?.[0]?.message ||
        errorData?.message ||
        "Failed to upload media file";
      console.error("[Media Library] POST error:", errorMessage);

      // Check if error is about duplicate media name
      const errorLower = errorMessage.toLowerCase();
      if (
        errorLower.includes("already exists") ||
        errorLower.includes("duplicate") ||
        errorLower.includes("conflict") ||
        errorLower.includes("taken")
      ) {
        return NextResponse.json(
          {
            error: "Media name already exists. Please choose a different name.",
          },
          { status: 409 }
        );
      }

      return NextResponse.json(
        { error: errorMessage },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json({ ok: true, data: data.data || data });
  } catch (err) {
    console.error("[Media Library] POST error:", err);
    return NextResponse.json(
      { error: "Failed to upload media file" },
      { status: 500 }
    );
  }
}
