import { withEmailUser } from '@/lib/email/api';
import { messagingTransferTargets } from '@/lib/acd/text-transfer.mjs';
export const GET=(request,context)=>withEmailUser(request,async({pool,agentId})=>messagingTransferTargets(pool,{workItemId:(await context.params).id,agentId,channel:'email'}));
