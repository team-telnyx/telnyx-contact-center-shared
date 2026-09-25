import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { createTelephonyCredential } from "@/lib/telnyx-credentials";
import { authenticateVoiceEndpoint, readVoiceEndpoints, registerVoiceEndpoint, chooseVoiceEndpoint, revokeVoiceEndpoint } from "@/lib/acd/voice-endpoints.mjs";
const options={route:'/api/contact-center/agent/voice-endpoints'};
export const GET=withPermission('authenticated',async (req,_ctx,{user}) => { if(req.headers.get('x-cc-endpoint-token')) await authenticateVoiceEndpoint(getPostgresPool(),user,req.headers.get('x-cc-endpoint-token')); return NextResponse.json(await readVoiceEndpoints(getPostgresPool(),String(user.id))); },options);
export const POST=withPermission(['agent:self','calls:supervise.listen','calls:supervise.whisper','calls:supervise.barge'],async (req,_ctx,{user}) => {
  const body=await req.json();
  const value=await registerVoiceEndpoint(getPostgresPool(),user,body,async (id) => {
    if (!process.env.TELNYX_API_KEY || !process.env.TELNYX_SIP_CONNECTION_ID) throw Object.assign(new Error('Voice provisioning is not configured'),{status:503});
    return createTelephonyCredential(process.env.TELNYX_API_KEY,{connectionId:process.env.TELNYX_SIP_CONNECTION_ID,name:`CC ${user.id} ${body.kind} ${id}`});
  });
  return NextResponse.json(value);
},options);
export const PUT=withPermission('agent:self',async (req,_ctx,{user}) => NextResponse.json(await chooseVoiceEndpoint(getPostgresPool(),user,await req.json())),options);
export const DELETE=withPermission('authenticated',async (req,_ctx,{user}) => NextResponse.json(await revokeVoiceEndpoint(getPostgresPool(),user,req.headers.get('x-cc-endpoint-token'))),options);
