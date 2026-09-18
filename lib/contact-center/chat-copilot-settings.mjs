import { z } from "zod";

export const COPILOT_MIN_TOKENS=256;
export const COPILOT_MAX_TOKENS=32768;
export const DEFAULT_CHAT_COPILOT_SETTINGS=Object.freeze({model:"meta-llama/Llama-3.3-70B-Instruct",bucketIds:[],maxTokens:6000});
const settingsSchema=z.object({model:z.string().trim().min(1).max(160),bucketIds:z.array(z.string().trim().min(1).max(255)).max(5),maxTokens:z.number().int().min(COPILOT_MIN_TOKENS).max(COPILOT_MAX_TOKENS).default(DEFAULT_CHAT_COPILOT_SETTINGS.maxTokens)}).strict();
export function parseChatCopilotSettings(value){
  const result=settingsSchema.safeParse(value);
  if(!result.success)throw Object.assign(new Error(result.error.issues.some(issue=>issue.path[0]==="maxTokens")?"Max tokens must be a whole number between 256 and 32,768":"Select an AI model and at most 5 knowledge buckets"),{status:400});
  return {...result.data,bucketIds:[...new Set(result.data.bucketIds)]};
}
export function chatCopilotFromAppSettings(value){
  return parseChatCopilotSettings(value?.chat_copilot||DEFAULT_CHAT_COPILOT_SETTINGS);
}
export async function loadChatCopilotSettings(db,channel="chat"){
  const result=await db.query("SELECT cc_settings FROM app_settings WHERE id='default'");
  const settings=result.rows[0]?.cc_settings;
  // Channel-specific configuration inherits the chat Copilot until saved.
  const own=channel!=="chat"&&/^[a-z][a-z0-9_]*$/.test(channel)?settings?.[`${channel}_copilot`]:null;
  return own ? parseChatCopilotSettings(own) : chatCopilotFromAppSettings(settings);
}
