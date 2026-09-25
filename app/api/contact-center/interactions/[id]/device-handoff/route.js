import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readDeviceHandoff, commandDeviceHandoff } from "@/lib/acd/device-handoff.mjs";
const options={route:'/api/contact-center/interactions/[id]/device-handoff'};
export const GET=withPermission('agent:self',async(request,context,{user})=>{
  const {id}=await context.params;
  return NextResponse.json(await readDeviceHandoff(getPostgresPool(),user,request,id),{headers:{'Cache-Control':'no-store'}});
},options);
export const POST=withPermission('agent:self',async(request,context,{user})=>{
  const {id}=await context.params;
  return NextResponse.json(await commandDeviceHandoff(getPostgresPool(),user,request,id,await request.json()),{headers:{'Cache-Control':'no-store'}});
},options);
