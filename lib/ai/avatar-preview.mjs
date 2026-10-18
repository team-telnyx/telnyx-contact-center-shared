const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isAvatarImageFile(file) {
  return Boolean(file && IMAGE_TYPES.has(file.type) && file.size > 0 && file.size <= 10 * 1024 * 1024);
}

// Decode raster pixels without interpreting the uploaded blob as a DOM URL.
export async function drawAvatarPreview(canvas, file, { signal } = {}) {
  if (!isAvatarImageFile(file)) throw new Error("Invalid image data");
  const bitmap = await createImageBitmap(file);
  try {
    if (signal?.aborted) return false;
    if (bitmap.width < 256 || bitmap.height < 256 || bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 40_000_000) {
      throw new Error("Invalid image data");
    }
    const scale = Math.min(320 / bitmap.width, 160 / bitmap.height, 1);
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Invalid image data");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return true;
  } finally {
    bitmap.close();
  }
}
