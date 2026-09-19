import { withEmailUser,readEmailJson } from '@/lib/email/api';
import { createOutboundEmail,emailComposeMailboxes } from '@/lib/acd/email-work.mjs';
export const GET=request=>withEmailUser(request,async({pool,agentId})=>({mailboxes:await emailComposeMailboxes(pool,agentId)}));
export const POST=request=>withEmailUser(request,async({pool,agentId})=>createOutboundEmail(pool,{...await readEmailJson(request),agentId}));
