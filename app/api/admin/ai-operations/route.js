import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { withPermission } from '@/lib/authz/guard';
import { AI_OPERATIONS, operationConfigSchema } from '@/lib/ai-operations/catalog.mjs';
import { parseChatCopilotSettings } from '@/lib/contact-center/chat-copilot-settings.mjs';
import { aiOperationsPayload as payload, operationRevision as revision, COPILOT_CHANNELS as channels } from '@/lib/ai-operations/settings-payload.mjs';
export const dynamic='force-dynamic';
async function GET_handler(_request,_context,authz){
  const pool=getPostgresPool();
  if(!pool)return NextResponse.json({error:'Database unavailable'},{status:503});
  const result=await pool.query("SELECT cc_settings FROM app_settings WHERE id='default'");
  return NextResponse.json(payload(result.rows[0]?.cc_settings||{},authz.can('system_settings:update')),{headers:{'Cache-Control':'no-store'}});
}
const schema=z.object({id:z.enum(AI_OPERATIONS.map(x=>x.id)),revision:z.string().length(64),config:operationConfigSchema,channel:z.enum(channels).optional(),copilot:z.unknown().optional()}).strict();
async function PUT_handler(request,_context,authz){
  const parsed=schema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:'Invalid AI settings. Select an operation and keep instructions within 6,000 characters.'},{status:400});
  const {id,revision:expected,config,channel,copilot}=parsed.data;
  let normalized;
  try{
    if(channel&&id!=='reply-suggestions')throw Error('Channel configuration is only available for reply suggestions');
    if(channel)normalized=copilot===null&&channel!=='chat'?null:parseChatCopilotSettings(copilot);
  }catch(error){return NextResponse.json({error:error.message},{status:400});}
  const pool=getPostgresPool();
  if(!pool)return NextResponse.json({error:'Database unavailable'},{status:503});
  const tx=await pool.connect();
  try{
    await tx.query('BEGIN');
    await tx.query("INSERT INTO app_settings(id,cc_settings) VALUES('default','{}'::jsonb) ON CONFLICT(id) DO NOTHING");
    const current=(await tx.query("SELECT cc_settings FROM app_settings WHERE id='default' FOR UPDATE")).rows[0]?.cc_settings||{};
    if(revision(current,id)!==expected){await tx.query('ROLLBACK');return NextResponse.json({error:'These settings changed in another session. Reload before saving.'},{status:409});}
    const next={...current,ai_operations:{...current.ai_operations,[id]:config}};
    if(channel){if(normalized===null)delete next[`${channel}_copilot`];else next[`${channel}_copilot`]=normalized;}
    await tx.query("UPDATE app_settings SET cc_settings=$1::jsonb,updated_by=$2,updated_at=now() WHERE id='default'",[JSON.stringify(next),authz.user.username||authz.user.email||authz.user.id]);
    await tx.query('COMMIT');
    return NextResponse.json(payload(next,true));
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
export const GET=withPermission('system_settings:read',GET_handler,{route:'/api/admin/ai-operations'});
export const PUT=withPermission('system_settings:update',PUT_handler,{route:'/api/admin/ai-operations'});
