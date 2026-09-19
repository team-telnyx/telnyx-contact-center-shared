import { widgetAiRequest } from "../widgets/ai-provider.js";
import { requireChatCopilotAccess } from "./chat-copilot.js";
import { widgetDynamicVariables } from "../widgets/dynamic-variables.js";

const cache=new Map();
const privateKey=/(token|secret|password|authorization|api.?key|cc_handoff|widget_session)/i;
export function safeChatMetadata(input){
  if(!input||typeof input!=="object"||Array.isArray(input))return {};
  return Object.fromEntries(Object.entries(input).filter(([key,value])=>!privateKey.test(key)&&["string","number","boolean"].includes(typeof value))
    .slice(0,80).map(([key,value])=>[key,typeof value==="string"?value.slice(0,2000):value]));
}
const nonnegative=value=>value!==null&&value!==undefined&&value!==""&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
export function summarizeChatCosts(data){
  const root=data?.data||data;
  const total=nonnegative(root?.cost?.cumulative_cost??root?.cost?.event_cost);
  const items=[];
  function visit(node,depth=0){
    if(!node||depth>5)return;
    const amount=nonnegative(node.cost?.event_cost);
    if(amount!==null)items.push({name:node.product||node.event_name||"AI inference",amount,currency:node.cost?.currency||"USD"});
    for(const child of (node.children||[]).slice(0,100))visit(child,depth+1);
  }
  visit(root);
  return {total,currency:root?.cost?.currency||"USD",items};
}

export async function readChatAiContext(db,identity,{request=widgetAiRequest}={}){
  const work=await requireChatCopilotAccess(db,identity);
  const session=(await db.query(`SELECT s.provider_conversation_id,s.assistant_id,s.context,s.created_at,w.name AS widget_name,q.name AS queue_name
    FROM cc_widget_sessions s JOIN cc_widgets w ON w.id=s.widget_id LEFT JOIN cc_queues q ON q.id=$2 WHERE s.conversation_id=$1`,[work.conversation_id,work.queue_id])).rows[0];
  const conversationId=session?.provider_conversation_id;
  let remote={insights:[],billing:null};
  if(conversationId){
    const key=conversationId,old=cache.get(key);
    if(request===widgetAiRequest&&old&&old.expires>Date.now())remote=await old.promise;
    else{
      const promise=(async()=>{
        const results=await Promise.allSettled([
          request(`/ai/conversations/${encodeURIComponent(conversationId)}/conversations-insights`),
          // Telnyx session-analysis metadata identifies this as the messaging
          // assistant record type. Web chat billing may not be published yet.
          request(`/session_analysis/ai-messaging-assistant-ai-messaging-assistant/${encodeURIComponent(conversationId)}?include_children=true&max_depth=3&expand=none`),
        ]);
        const entries=results[0].status==="fulfilled"?results[0].value.data||[]:[];
        const insights=(Array.isArray(entries)?entries:[]).flatMap(e=>(e.conversation_insights||[e]).map(i=>({
          id:i.insight_id||i.id,name:i.name||i.title||"Conversation insight",result:typeof i.result==="string"?i.result.slice(0,10000):JSON.stringify(i.result||{}),createdAt:e.created_at,
        }))).slice(0,30);
        return {insights,insightsUnavailable:results[0].status==="rejected",billing:results[1].status==="fulfilled"?summarizeChatCosts(results[1].value):null};
      })();
      if(request===widgetAiRequest){if(cache.size>=200)cache.delete(cache.keys().next().value);cache.set(key,{promise,expires:Date.now()+60000});}
      remote=await promise;
    }
  }
  const generations=(await db.query(`SELECT response->'usage' AS usage,response->>'model' AS model,created_at FROM acd_chat_copilot_requests
    WHERE work_item_id=$1 AND state='completed' ORDER BY created_at`,[work.id])).rows;
  await requireChatCopilotAccess(db,identity);
  return {handoff:work.attributes?.handoff||null,insights:remote.insights,insightsUnavailable:remote.insightsUnavailable||false,
    metadata:{...safeChatMetadata(session?.context),conversationId:work.conversation_id,providerConversationId:conversationId||null,assistantId:session?.assistant_id||null,
      widget:session?.widget_name||null,queue:session?.queue_name||null,startedAt:session?.created_at||work.created_at},
    variables:safeChatMetadata(widgetDynamicVariables(session?.context||{})),costs:{assistant:remote.billing,copilot:generations}};
}
