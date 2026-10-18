import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { deleteTelephonyCredential } from "@/lib/telnyx-credentials";
import { forgetVoiceEndpoint } from "@/lib/acd/voice-endpoints.mjs";
// "Forget this device" by one of its registrations: the whole phone or tablet it belongs to. The computer refuses.
export const DELETE=withPermission('authenticated',async (_req,ctx,{user}) => {
  const {id}=await ctx.params;
  if(!/^[0-9a-f-]{36}$/i.test(id||''))return NextResponse.json({error:'Unknown device.'},{status:400});
  return NextResponse.json(await forgetVoiceEndpoint(getPostgresPool(),user,id,{release:(credentialId)=>deleteTelephonyCredential(process.env.TELNYX_API_KEY,credentialId)}));
},{route:'/api/contact-center/agent/voice-endpoints/[id]'});
