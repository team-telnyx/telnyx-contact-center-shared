import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { whatsappProfilePhoto } from "@/lib/whatsapp/admin.mjs";
import { withPermission } from "@/lib/authz/guard";

// Business profile photo for a WhatsApp number (multipart, JPEG/PNG ≤ 10 MB).
async function handle(request,_context,authz){
  const user=authz.user;
  const origin=request.headers.get("origin");
  if(origin){try{if(new URL(origin).host!==request.headers.get("host"))return NextResponse.json({error:"Cross-origin WhatsApp operation is not allowed"},{status:403});}catch{return NextResponse.json({error:"Invalid origin"},{status:403});}}
  if(Number(request.headers.get("content-length")||0)>11*1048576)return NextResponse.json({error:"Profile photo may not exceed 10 MB"},{status:413});
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{
    if(request.method==="DELETE")return NextResponse.json(await whatsappProfilePhoto(pool,{phoneNumber:new URL(request.url).searchParams.get("phone"),remove:true},String(user.id)));
    const form=await request.formData();
    return NextResponse.json(await whatsappProfilePhoto(pool,{phoneNumber:form.get("phoneNumber"),file:form.get("file")},String(user.id)));
  }catch(error){return NextResponse.json({error:error.status?error.message:"Profile photo update failed"},{status:error.status||500});}
}
export const POST = withPermission("whatsapp_admin:update", handle, { route: "/api/admin/whatsapp/photo" });
export const DELETE = withPermission("whatsapp_admin:update", handle, { route: "/api/admin/whatsapp/photo" });
