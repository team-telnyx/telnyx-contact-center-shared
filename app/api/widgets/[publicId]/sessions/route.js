import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { bearerToken,widgetAdmissionKey } from "@/lib/widgets/session-tokens";
import { startWidgetSession } from "@/lib/widgets/sessions";

export async function POST(request,context){
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Service unavailable"},{status:503});
  try{
    const {publicId}=await context.params;const body=await request.json();
    if(!["messaging","voice","video"].includes(body.channel))return NextResponse.json({error:"Channel unavailable"},{status:400});
    return NextResponse.json(await startWidgetSession(pool,{publicId,bootstrapToken:bearerToken(request),
      channel:body.channel,sessionToken:body.sessionToken,clientKey:body.clientKey,admissionKey:widgetAdmissionKey(request),context:body.context}),{headers:{"Cache-Control":"no-store"}});
  }catch(error){return NextResponse.json({error:error.status?error.message:"Unable to start chat"},{status:error.status||500});}
}
