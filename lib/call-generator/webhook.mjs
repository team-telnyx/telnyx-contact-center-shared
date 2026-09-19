import { verifyTelnyxSignature } from '../telnyx-webhooks.js';
import { admitAcdVoiceEvent } from '../acd/admission.mjs';
import { persistGeneratorWebhook,ownsGeneratorEvent } from './runtime.mjs';

// Used by Next and by the standalone ingress. There is deliberately no test
// bypass: even development uses the real provider signature over the raw body.
export async function receiveGeneratorWebhook(request,pool,{verify=verifyTelnyxSignature,admit=admitAcdVoiceEvent,persist=persistGeneratorWebhook,owns=ownsGeneratorEvent}={}) {
  if(!pool) return {status:503,body:{error:'Database unavailable'}};
  const raw=await request.text();
  if(Buffer.byteLength(raw)>1024*1024) return {status:413,body:{error:'Webhook too large'}};
  if(!await verify(request,raw)) return {status:401,body:{error:'Invalid signature'}};
  let body;
  try{body=JSON.parse(raw);}catch{return {status:400,body:{error:'Invalid JSON'}};}
  const event={eventId:body.data?.id || body.id,eventType:body.data?.event_type || body.event_type,
    occurredAt:body.data?.occurred_at || body.occurred_at,payload:body.data?.payload || body.payload,sourceRoute:'voice'};
  if(!event.eventId || !event.eventType || !event.payload?.call_control_id) return {status:400,body:{error:'Incomplete call event'}};
  try{
    if(await owns(pool,event)) {
      await persist(pool,event);
      return {status:200,body:{ok:true,durable:true,owner:'generator'}};
    }
    // A device/core leg sent here by provider override still enters the core's
    // normal durable admission. Never forward an arbitrary marker to legacy.
    const core=await admit(pool,event);
    if(core.retryable) return {status:core.httpStatus || 503,body:{error:'Core intake unavailable'}};
    if(core.handled) return {status:200,body:{ok:true,durable:true,owner:'acd_core'}};
    await persist(pool,event);
    return {status:200,body:{ok:true,durable:true,owner:'generator'}};
  }catch{return {status:503,body:{error:'Durable intake unavailable'}};}
}
