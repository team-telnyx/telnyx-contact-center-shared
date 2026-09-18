import { NextResponse } from 'next/server';
import { getPostgresPool } from '../postgres.mjs';
import { requirePermission, AuthzError } from '../authz/guard';

const ADMIN_RESOURCE = { Email: 'email_admin', SMS: 'sms_admin', WhatsApp: 'whatsapp_admin' };

/**
 * Channel request wrapper. Agent work runs under `agent:self`; administration
 * (`admin: true`) needs the channel's admin resource — `<resource>:read` for
 * GET and `<resource>:update` otherwise — unless `permission` names one.
 */
export async function withEmailUser(request, operation, {admin=false,label='Email',permission}={}) {
  const required = permission || (admin ? `${ADMIN_RESOURCE[label] || 'email_admin'}:${['GET','HEAD'].includes(request.method) ? 'read' : 'update'}` : 'agent:self');
  let authz;
  try {
    authz = await requirePermission(required, { request, route: `${label.toLowerCase()} api` });
  } catch (error) {
    if (error instanceof AuthzError) return NextResponse.json({error: error.status === 401 ? 'Unauthorized' : (admin ? 'Administrator access required' : 'Forbidden')}, {status: error.status});
    throw error;
  }
  const user = authz.user;
  if(!['GET','HEAD'].includes(request.method)){
    const origin=request.headers.get('origin');
    let sameOrigin=!origin;
    try{sameOrigin ||= origin===new URL(request.url).origin || /^https?:$/.test(new URL(origin).protocol)&&new URL(origin).host===request.headers.get('host');}catch{}
    if(!sameOrigin)return NextResponse.json({error:`Cross-origin ${label.toLowerCase()} operation is not allowed`},{status:403});
    if(Number(request.headers.get('content-length')||0)>8_000_000)return NextResponse.json({error:`${label} request exceeds the size limit`},{status:413});
  }
  const pool=getPostgresPool();
  if(!pool)return NextResponse.json({error:'Database unavailable'},{status:503});
  try{return NextResponse.json(await operation({pool,user,agentId:String(user.id),authz}),{headers:{'Cache-Control':'private, no-store'}});}
  catch(error){return NextResponse.json({error:error.status?error.message:`${label} operation failed`,...(error.requestState==='failed'?{requestState:'failed'}:{})},{status:error.status||500});}
}
export async function readEmailJson(request) {
  if(!request.body)throw Object.assign(Error('JSON request body is required'),{status:400});
  let size=0;const parts=[];
  for await(const part of request.body){size+=part.length;if(size>8_000_000)throw Object.assign(Error('Email request exceeds the size limit'),{status:413});parts.push(Buffer.from(part));}
  try{return JSON.parse(Buffer.concat(parts).toString());}catch{throw Object.assign(Error('Invalid JSON request'),{status:400});}
}
