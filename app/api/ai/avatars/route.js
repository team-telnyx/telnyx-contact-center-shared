import { readConferenceBody } from "@/lib/video/request-body.mjs";
import { withPermission } from "@/lib/authz/guard";
import { AVATAR_UPLOAD_LIMIT, createTelnyxAvatar, listTelnyxAvatars, renameTelnyxAvatar } from "@/lib/ai/telnyx-avatars.mjs";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
async function respond(operation) {
  try { return Response.json(await operation(), { headers }); }
  catch (error) { return Response.json({ error: error.status ? error.message : "Avatar operation failed" }, { status: error.status || 500, headers }); }
}
function checkOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  try { if (origin === new URL(request.url).origin || new URL(origin).host === request.headers.get("host")) return; } catch { /* Invalid origins are denied. */ }
  throw Object.assign(new Error("Cross-origin administration is not allowed"), { status: 403 });
}
export const GET = withPermission(["widgets:read", "ai_assistants:read"], () => respond(async () => ({ avatars: await listTelnyxAvatars() })));
export const POST = withPermission(["widgets:update", "ai_assistants:update"], request => respond(async () => {
  checkOrigin(request);
  if (process.env.TELNYX_CUSTOM_AVATARS_ENABLED === "false") throw Object.assign(new Error("Custom avatar uploads are disabled"), { status: 503 });
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error("Image is required"), { status: 400 });
  const parts = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > AVATAR_UPLOAD_LIMIT + 65536) { await reader.cancel(); throw Object.assign(new Error("Image upload is too large"), { status: 413 }); } parts.push(value); }
  let form;
  try { form = await new Response(new Blob(parts), { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData(); }
  catch { throw Object.assign(new Error("Invalid image form"), { status: 400 }); }
  const file = form.get("image_file");
  if (!file?.arrayBuffer) throw Object.assign(new Error("Image is required"), { status: 400 });
  return { avatar: await createTelnyxAvatar(new Uint8Array(await file.arrayBuffer()), form.get("name")) };
}));
export const PATCH = withPermission(["widgets:update", "ai_assistants:update"], request => respond(async () => {
  checkOrigin(request);
  const { id, name } = await readConferenceBody(request);
  return { avatar: await renameTelnyxAvatar(id, name) };
}));
