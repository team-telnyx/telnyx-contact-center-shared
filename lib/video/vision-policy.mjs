// Source identities are assigned by the room bridge from authenticated member
// bindings. A publication generation changes whenever its track is replaced.
export const sourceKey = source => source ? `${source.participantId}:${source.streamKey}:${source.generation}` : null;
export function eligibleVisionSources(sources, config) {
  if (config?.mode !== "live") return [];
  return sources.filter(s => s.available && s.consented && ["agent", "customer"].includes(s.role) && config.allowedSources.includes(s.type));
}
export function chooseVisionSource({ sources, config, current = null, pinned = null }) {
  const eligible = eligibleVisionSources(sources, config);
  if (config.selection === "manual" || pinned) return eligible.find(s => sourceKey(s) === pinned) || null;
  const screens = eligible.filter(s => s.type.endsWith("-screen"));
  const previous = eligible.find(s => sourceKey(s) === sourceKey(current));
  if (previous?.type.endsWith("-screen")) return previous;
  if (screens.length > 1) return null; // Never guess between two different owners.
  if (screens.length === 1) return screens[0];
  return eligible.find(s => s.type === config.preferredCamera) || null;
}
export function visionImageFrame(imageUrl, capturedAt = new Date().toISOString()) {
  if (typeof imageUrl !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(imageUrl)) throw new Error("Invalid Vision image");
  const frame = { type: "conversation.item.create", item: { type: "message", role: "user", buffer: true, captured_at: capturedAt, content: [{ type: "input_image", image_url: imageUrl }] } };
  if (new TextEncoder().encode(JSON.stringify(frame)).byteLength >= 1024 * 1024) throw new Error("Vision frame exceeds the 1 MiB message limit");
  return frame;
}
