import { withEmailUser,readEmailJson } from '@/lib/email/api';
import { generateChatCopilot,readChatCopilot } from '@/lib/contact-center/chat-copilot';
export const GET=(request,context)=>withEmailUser(request,async({pool,agentId})=>readChatCopilot(pool,{workItemId:(await context.params).id,agentId,channel:'email'}));
export const POST=(request,context)=>withEmailUser(request,async({pool,agentId})=>generateChatCopilot(pool,{...await readEmailJson(request),workItemId:(await context.params).id,agentId,channel:'email'}));
