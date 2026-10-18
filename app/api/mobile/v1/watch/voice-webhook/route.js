import { NextResponse } from 'next/server';
import { verifyTelnyxSignature } from '@/lib/telnyx-webhooks';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { ensureWatchAudioSchema, watchAudioStore } from '@/lib/watch-audio/sessions.mjs';
import { telnyxVoiceRequest } from '@/lib/watch-audio/outbound.mjs';
export const runtime='nodejs';
export async function POST(request) {
  const raw=await request.text();
  if(!await verifyTelnyxSignature(request,raw))return NextResponse.json({error:'Invalid signature'},{status:401});
  try {
    const {data}=JSON.parse(raw), payload=data?.payload || {};
    let state;
    try { state=JSON.parse(Buffer.from(payload.client_state || '', 'base64').toString()); } catch { return NextResponse.json({ok:true}); }
    if(state.kind!=='watch_outbound' || !/^[a-f0-9-]{36}$/.test(state.id || ''))return NextResponse.json({ok:true});
    const pool=getPostgresPool(); await ensureWatchAudioSchema(pool);
    const store=watchAudioStore(pool), row=await store.status(state.id);
    if(!row?.target || !payload.call_control_id || String(payload.connection_id)!==String(row.target.connectionId))return NextResponse.json({ok:true});
    if(row.provider_call_id && row.provider_call_id!==payload.call_control_id)return NextResponse.json({ok:true});
    await store.dialed(row.id,payload.call_control_id);
    if(data.event_type==='call.hangup') {
      await pool.query("UPDATE watch_audio_sessions SET call_state='ended' WHERE id=$1",[row.id]);
      await store.end(row.id,true);
    } else if(row.state==='ended' || new Date(row.lease_until)<new Date()) {
      await telnyxVoiceRequest(`/calls/${encodeURIComponent(payload.call_control_id)}/actions/hangup`,{command_id:row.id+'-end'});
      await store.end(row.id,true);
    } else if(data.event_type==='call.answered') {
      await pool.query("UPDATE watch_audio_sessions SET call_state='answered' WHERE id=$1 AND state<>'ended'",[row.id]);
    }
    return NextResponse.json({ok:true});
  }catch {return NextResponse.json({error:'Webhook processing failed'},{status:503});}
}
