import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { verifyWhatsAppMediaToken } from "@/lib/whatsapp/media.mjs";

// Unauthenticated, signed and expiring link that WhatsApp (via Telnyx) fetches
// when an agent sends media. Only outbound WhatsApp attachments are served.
async function serve(request,context,{ head=false }={}){
  const {attachmentId}=await context.params;
  const url=new URL(request.url);
  if(!verifyWhatsAppMediaToken(attachmentId,url.searchParams.get("exp"),url.searchParams.get("sig")))return new NextResponse(null,{status:404});
  const pool=getPostgresPool();if(!pool)return new NextResponse(null,{status:503});
  const file=(await pool.query(`SELECT f.name,f.content_type,f.byte_size${head?"":",f.bytes"} FROM acd_text_attachments f JOIN cc_whatsapp_messages w ON w.message_id=f.message_id
    WHERE f.id=$1 AND w.direction='outbound'`,[attachmentId])).rows[0];
  if(!file)return new NextResponse(null,{status:404});
  const safeName=String(file.name||"media").replace(/[^\x20-\x7e]/g,"_").replace(/["\\]/g,"_");
  const headers={"content-type":file.content_type||"application/octet-stream","content-length":String(file.byte_size),"content-disposition":`inline; filename="${safeName}"`,
    "cache-control":"private, max-age=600","x-content-type-options":"nosniff","referrer-policy":"no-referrer","accept-ranges":"none"};
  return new Response(head?null:file.bytes,{status:200,headers});
}
export const GET=(request,context)=>serve(request,context);
export const HEAD=(request,context)=>serve(request,context,{head:true});
