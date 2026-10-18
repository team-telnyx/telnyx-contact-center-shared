import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { deleteTelephonyCredential } from "@/lib/telnyx-credentials";
import { forgetVoiceDevice, listVoiceDevices } from "@/lib/acd/voice-endpoints.mjs";
const options={route:'/api/contact-center/agent/voice-endpoints/devices'};
// The profile's device list: the one computer, then each phone or tablet.
export const GET=withPermission('authenticated',async (_req,_ctx,{user}) => NextResponse.json(await listVoiceDevices(getPostgresPool(),String(user.id))),options);
// "Forget" a phone or tablet by its device id: every registration, push registration and login of it. Never the computer.
export const DELETE=withPermission('authenticated',async (req,_ctx,{user}) => {
  const body=await req.json().catch(() => ({}));
  if(typeof body.deviceId!=='string'||!body.deviceId)return NextResponse.json({error:'Unknown device.'},{status:400});
  return NextResponse.json(await forgetVoiceDevice(getPostgresPool(),user,body.deviceId,{release:(credentialId)=>deleteTelephonyCredential(process.env.TELNYX_API_KEY,credentialId)}));
},options);
