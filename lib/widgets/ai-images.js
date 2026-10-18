import { createHash } from "node:crypto";
import sharp from "sharp";
import { getWidgetSession, actAsWidgetCustomer } from "./sessions.js";
import { admitTextAttachment, finishUpload, validateAttachment } from "./attachments.js";
import { withStreamedChatMessage } from "./multipart-upload.js";
import { assertWidgetAssistant } from "./ai-provider.js";
import { validateAssistantVision } from "../ai/vision-validation.mjs";

export const AI_IMAGE_POLICY = { maximumBytes: 5 * 1048576, maximumFiles: 3, maximumTotalBytes: 15 * 1048576, mimeTypes: ["image/png", "image/jpeg", "image/webp"] };
const fail = (message, status = 400) => Object.assign(new Error(message), { status, ambiguous: false });
export async function normalizeAiImage(file) {
  if (!AI_IMAGE_POLICY.mimeTypes.includes(file.type)) throw fail("Choose a PNG, JPEG or WebP image.");
  if (file.size > AI_IMAGE_POLICY.maximumBytes) throw fail("Each image must be at most 5 MiB.", 413);
  const input = Buffer.from(await file.arrayBuffer());
  if (input.length > AI_IMAGE_POLICY.maximumBytes) throw fail("Each image must be at most 5 MiB.", 413);
  validateAttachment(input, file.type);
  let bytes;
  try {
    // Decode the pixels, reject bombs/animations, apply orientation and strip metadata.
    const image = sharp(input, { limitInputPixels: 40000000, failOn: "warning" });
    const info = await image.metadata();
    if ((info.pages || 1) > 1) throw new Error("Animated image");
    bytes = await image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
  } catch { throw fail("The image could not be decoded. Choose a still PNG, JPEG or WebP image."); }
  if (bytes.length > AI_IMAGE_POLICY.maximumBytes) throw fail("Image is too large after processing.", 413);
  return { name: String(file.name || "image").replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 230).replace(/\.[^.]*$/, "") + ".webp", content_type: "image/webp", bytes, byte_size: bytes.length, content_hash: createHash("sha256").update(bytes).digest("hex") };
}
export async function receiveAiImageMessage(pool, { request, token }) {
  // Reserve quota and check permissions before consuming any file bytes.
  const admission = await admitTextAttachment(pool, { token, aiImages: true });
  try {
    const session = await getWidgetSession(pool, token);
    if (session.runtime_kind === "ai_chat") await validateAssistantVision(await assertWidgetAssistant(session.assistant_id));
    const policy = { ...AI_IMAGE_POLICY,
      maximumBytes: Math.min(AI_IMAGE_POLICY.maximumBytes, admission.maximumBytes),
      mimeTypes: AI_IMAGE_POLICY.mimeTypes.filter(type => admission.mimeTypes.includes(type)),
    };
    return await withStreamedChatMessage(request, policy, async ({ files, metadata }) => {
      let body; try { body = JSON.parse(metadata); } catch { throw fail("Invalid image message."); }
      if (typeof body.content !== "string" || body.content.length > 20000 || typeof body.messageId !== "string" || !body.messageId || body.messageId.length > 100) throw fail("Invalid image message.");
      const images = [];
      for (const file of files) images.push(await normalizeAiImage(file));
      return actAsWidgetCustomer(pool, { token, action: "send", content: body.content, messageId: body.messageId, images });
    });
  } finally { await finishUpload(pool, admission.id); }
}
