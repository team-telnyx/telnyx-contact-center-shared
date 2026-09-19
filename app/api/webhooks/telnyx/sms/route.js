import { NextResponse } from 'next/server';
import { verifyTelnyxSignature } from '@/lib/telnyx-webhooks';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { persistWebhookEvent } from '@/lib/acd/inbox.mjs';
import { smsEventKey } from '@/lib/sms/ingest.mjs';
import { whatsappEventKey, WHATSAPP_STATUS_EVENTS } from '@/lib/whatsapp/ingest.mjs';
export const runtime='nodejs';
const EVENTS=new Set(['message.received','message.sent','message.finalized',...WHATSAPP_STATUS_EVENTS]);
// Signed messaging-profile webhook: verify, persist in the durable ACD inbox, acknowledge.
// The worker routes inbound messages and applies delivery evidence. WhatsApp
// events arriving on a shared profile are handed to the WhatsApp inbox.
export async function POST(request){
  if(!request.body)return new NextResponse(null,{status:400});
  const parts=[];let size=0;
  for await(const chunk of request.body){size+=chunk.length;if(size>1_000_000)return new NextResponse(null,{status:413});parts.push(Buffer.from(chunk));}
  const raw=Buffer.concat(parts).toString('utf8');
  if(!await verifyTelnyxSignature(request,raw,{extraPublicKeys:[process.env.TELNYX_WEBHOOK_PUBLIC_KEY_WHATSAPP||'']}))return NextResponse.json({error:'Invalid messaging webhook signature'},{status:403});
  let data;try{data=JSON.parse(raw).data;}catch{return new NextResponse(null,{status:400});}
  if(!data?.id||!EVENTS.has(data.event_type)||!data.payload?.id)return new NextResponse(null,{status:400});
  const pool=getPostgresPool();if(!pool)return new NextResponse(null,{status:503});
  const whatsapp=String(data.payload.type||'').toUpperCase()==='WHATSAPP';
  await persistWebhookEvent(pool,{eventId:(whatsapp?whatsappEventKey:smsEventKey)('webhook',String(data.id)),provider:whatsapp?'telnyx-whatsapp':'telnyx-sms',eventType:data.event_type,
    occurredAt:data.occurred_at,payload:data.payload,sourceRoute:'/api/webhooks/telnyx/sms'});
  return NextResponse.json({ok:true});
}
