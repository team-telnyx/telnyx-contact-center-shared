import { createHash, randomUUID } from "node:crypto";
import { resolveWebhookBaseUrl } from "../webhook-base-url.mjs";
import { widgetAiRequest } from "./ai-provider.js";
import { widgetHandoffServiceToken } from "./session-tokens.js";

export const WIDGET_HANDOFF_PATH = "/api/widgets/handoff";
const fail=(message,status=503)=>Object.assign(new Error(message),{status});
const resource=response=>response?.data||response;

export function widgetHandoffToolDefinition({installationId,baseUrl,secretIdentifier}) {
  const origin=new URL(baseUrl);
  if(origin.protocol!=="https:" || origin.username || origin.password || origin.search || origin.hash || !["","/"].includes(origin.pathname))
    throw fail("Configure a public HTTPS origin for widget handoff");
  const name=`cc_chat_handoff_${installationId.replaceAll("-","").slice(0,12)}`;
  return {
    type:"webhook",display_name:`Contact Center Chat Handoff · ${origin.host}`,timeout_ms:10000,
    webhook:{name,description:"Transfer this Contact Center web_chat conversation to a human agent queue when the customer requests a person or needs human support. Use only for web_chat with private widget integration context. Never use for voice, SMS or unrelated assistant conversations. On success stop answering as the AI; the Contact Center widget shows the queue and agent notifications.",
      url:`${origin.origin}${WIDGET_HANDOFF_PATH}`,method:"POST",async:false,
      headers:[{name:"Content-Type",value:"application/json"},
        {name:"telnyx-ai-api-key",value:`{{#integration_secret}}${secretIdentifier}{{/integration_secret}}`},
        {name:"x-cc-widget-handoff-token",value:"{{cc_widget_handoff_token}}"}],
      body_parameters:{type:"object",properties:{
        widget_session_id:{type:"string",description:"Copy the exact widget_session_id from the private integration context. Never ask the customer for this value."},
        telnyx_conversation_channel:{type:"string",enum:["web_chat"]},
        queue_name:{type:"string",description:"Exact eligible Contact Center queue name from the private integration context. Omit to use this widget's default queue."},
        reason:{type:"string",description:"Why a human agent is needed."},
        summary:{type:"string",description:"Brief factual summary for the human agent, including the customer's request and actions already taken."},
        intent:{type:"string",description:"Short customer intent label."},
        sentiment:{type:"string",enum:["positive","neutral","negative","mixed","unknown"]},
      },required:["widget_session_id","telnyx_conversation_channel","reason","summary"],additionalProperties:false},
    },
  };
}

async function listAll(request,path) {
  const result=[];
  for(let page=1;page<=100;page++){
    const response=await request(`${path}?page[number]=${page}&page[size]=100`);
    if(!Array.isArray(response?.data))throw fail("Invalid Telnyx resource listing");
    result.push(...response.data);
    if(page>=Number(response.meta?.total_pages||1))return result;
  }
  throw fail("Telnyx resource listing exceeded the supported page count");
}

// A renewable database lease serializes publishers across processes without
// holding a transaction, widget row lock or pool connection during provider I/O.
// Record creation intent before POST; uncertain retries discover the same remote
// tool and never issue another blind create.
export async function ensureWidgetHandoffTool(pool,{config,assistantIds,beforeMutation,request=widgetAiRequest,baseUrl=resolveWebhookBaseUrl()}={}) {
  const initialId=randomUUID(),leaseId=randomUUID();
  await pool.query("INSERT INTO cc_widget_handoff_integration(singleton,installation_id) VALUES(true,$1) ON CONFLICT DO NOTHING",[initialId]);
  const state=(await pool.query(`UPDATE cc_widget_handoff_integration SET lease_id=$1,lease_until=now()+interval '2 minutes'
    WHERE singleton=true AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,[leaseId])).rows[0];
  if(!state)throw fail("Another widget publication is configuring handoff. Retry publication shortly.",409);
  const guardedRequest=async(path,options)=>{
    const renewed=await pool.query("UPDATE cc_widget_handoff_integration SET lease_until=now()+interval '2 minutes' WHERE singleton=true AND lease_id=$1",[leaseId]);
    if(!renewed.rowCount)throw fail("Widget handoff provisioning lease changed. Retry publication.",409);
    if(options?.method&&options.method!=='GET'){
      try{await beforeMutation?.();}catch(error){error.ambiguous=false;throw error;}
    }
    return request(path,options);
  };
  try{
    const token=widgetHandoffServiceToken(state.installation_id);
    const fingerprint=createHash("sha256").update(token).digest("hex").slice(0,12);
    const secretIdentifier=`cc_widget_handoff_${state.installation_id.replaceAll("-","")}_${fingerprint}`;
    const definition=widgetHandoffToolDefinition({installationId:state.installation_id,baseUrl,secretIdentifier});
    const secrets=await listAll(guardedRequest,"/integration_secrets");
    if(!secrets.some(secret=>secret.identifier===secretIdentifier)){
      try{await guardedRequest("/integration_secrets",{method:"POST",body:{identifier:secretIdentifier,type:"bearer",token}});}
      catch(error){
        // A duplicate or a lost response can be recovered by its unique identifier.
        if(!(await listAll(guardedRequest,"/integration_secrets")).some(secret=>secret.identifier===secretIdentifier))throw error;
      }
    }
    let tool=null;
    if(state.tool_id){
      try{tool=resource(await guardedRequest(`/ai/tools/${encodeURIComponent(state.tool_id)}`));}
      catch(error){
        if(error.providerStatus!==404)throw error;
        state.creation_state="new";
        await pool.query("UPDATE cc_widget_handoff_integration SET tool_id=NULL,creation_state='new' WHERE singleton=true AND lease_id=$1",[leaseId]);
      }
    }
    if(!tool){
      const matches=(await listAll(guardedRequest,"/ai/tools")).filter(item=>{
        const webhook=item.webhook||item.tool_definition?.webhook||item.tool_definition;
        return webhook?.name===definition.webhook.name;
      });
      if(matches.length>1)throw fail("Multiple managed widget handoff tools exist; resolve the duplicate before publishing");
      tool=matches[0]||null;
    }
    if(!tool){
      if(state.creation_state==="creating")throw fail("The previous handoff tool creation is unconfirmed. Retry after the tool appears in Telnyx Tools Library.");
      await pool.query("UPDATE cc_widget_handoff_integration SET creation_state='creating' WHERE singleton=true AND lease_id=$1",[leaseId]);
      try{tool=resource(await guardedRequest("/ai/tools",{method:"POST",body:definition}));}
      catch(error){
        if(error.ambiguous===false)await pool.query("UPDATE cc_widget_handoff_integration SET creation_state='new' WHERE singleton=true AND lease_id=$1",[leaseId]);
        throw error;
      }
    }
    const toolId=tool?.id||tool?.tool_id;
    if(!toolId)throw fail("Telnyx did not confirm the shared handoff tool ID");
    await pool.query(`UPDATE cc_widget_handoff_integration SET tool_id=$2,tool_name=$3,secret_identifier=$4,creation_state='ready',updated_at=now()
      WHERE singleton=true AND lease_id=$1`,[leaseId,toolId,definition.webhook.name,secretIdentifier]);
    await guardedRequest(`/ai/tools/${encodeURIComponent(toolId)}`,{method:"PATCH",body:definition});
    const ids=[...new Set(assistantIds||[config?.channels.messaging.assistantId,config?.channels.voice.assistantId].filter(Boolean))];
    for(const assistantId of ids){
      // The dedicated attach endpoint preserves all other assistant tools,
      // instructions and settings, including inline tools.
      await guardedRequest(`/ai/assistants/${encodeURIComponent(assistantId)}/tools/${encodeURIComponent(toolId)}`,{method:"PUT"});
    }
    return {id:toolId,name:definition.webhook.name,assistantIds:ids};
  }finally{
    await pool.query("UPDATE cc_widget_handoff_integration SET lease_id=NULL,lease_until=NULL WHERE singleton=true AND lease_id=$1",[leaseId]);
  }
}
