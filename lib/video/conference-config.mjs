import { z } from "zod";
export const VISION_SOURCE_TYPES = ["customer-camera", "agent-camera", "customer-screen", "agent-screen"];
const id = z.string().trim().max(200).default("");
export const videoAiSchema = z.object({
  assistantId: id,
  allowAgentInvite: z.boolean().default(false),
  allowedAssistantIds: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  afterAgentJoins: z.enum(["muted", "active", "leave"]).default("muted"),
  avatar: z.object({ enabled: z.boolean().default(false), provider: z.literal("telnyx").default("telnyx"), avatarId: id,
    name: z.string().max(255).default(""), previewUrl: z.string().max(8192).default(""), backgroundId: z.enum(["studio", "office", "reception"]).default("studio") }).prefault({}),
  vision: z.object({ mode: z.enum(["disabled", "uploads", "live"]).default("disabled"),
    addToolOnPublish: z.boolean().default(false),
    allowedSources: z.array(z.enum(VISION_SOURCE_TYPES)).default(VISION_SOURCE_TYPES),
    selection: z.enum(["manual", "automatic"]).default("automatic"),
    preferredCamera: z.enum(["customer-camera", "agent-camera"]).default("customer-camera"),
    agentControls: z.boolean().default(true), maxFrameAgeSecs: z.literal(10).default(10), intervalMs: z.literal(2000).default(2000),
  }).prefault({}),
}).prefault({});
export const DEFAULT_VIDEO_AI = videoAiSchema.parse({});
export function videoUsesAi(video) { return video?.routing?.destination === "assistant" || Boolean(video?.ai?.allowAgentInvite); }
export function videoAssistantIds(video) {
  return [...new Set([video?.ai?.assistantId, ...(video?.ai?.allowAgentInvite ? video.ai.allowedAssistantIds : [])].filter(Boolean))];
}
export function validateVideoConferenceConfig(video) {
  if (!video?.enabled) return;
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!video.routing.queueId) fail("Select a Contact Center video queue for routing and fallback");
  if (video.routing.destination === "agent" && !video.routing.agentId) fail("Select the destination agent");
  if (videoUsesAi(video)) {
    if (!video.ai.assistantId) fail("Select a video AI assistant");
    if (video.ai.avatar.enabled && !video.ai.avatar.avatarId) fail("Select the video assistant avatar");
  }
}
export function publicVideoAi(video) {
  return { enabled: videoUsesAi(video), startsWithAi: video?.routing?.destination === "assistant",
    avatar: video.ai.avatar, vision: video.ai.vision, afterAgentJoins: video.ai.afterAgentJoins };
}
