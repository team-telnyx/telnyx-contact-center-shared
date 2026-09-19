import { NextResponse } from 'next/server';
import { verifyTelnyxSignature } from '@/lib/telnyx-webhooks';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { persistWebhookEvent } from '@/lib/acd/inbox.mjs';
import { emailEventKey } from '@/lib/email/ingest.mjs';
export const runtime='nodejs';
export async function POST(request){
  if(!request.body)return new NextResponse(null,{status:400});
  const parts=[];let size=0;
  for await(const chunk of request.body){size+=chunk.length;if(size>1_000_000)return new NextResponse(null,{status:413});parts.push(Buffer.from(chunk));}
  const raw=Buffer.concat(parts).toString('utf8');
  if(!await verifyTelnyxSignature(request,raw))return NextResponse.json({error:'Invalid email webhook signature'},{status:403});
  let data;try{data=JSON.parse(raw).data;}catch{return new NextResponse(null,{status:400});}
  if(!data?.id||!/^email\./.test(data.event_type||''))return new NextResponse(null,{status:400});
  const pool=getPostgresPool();if(!pool)return new NextResponse(null,{status:503});
  await persistWebhookEvent(pool,{eventId:emailEventKey('webhook',String(data.id)),provider:'telnyx-email',eventType:data.event_type,
    occurredAt:data.occurred_at,payload:data.payload||{},sourceRoute:'/api/webhooks/telnyx/email'});
  return NextResponse.json({ok:true});
}
