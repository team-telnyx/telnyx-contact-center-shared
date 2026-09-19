import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { authenticateWidgetHandoff,handoffWidgetChat } from "@/lib/widgets/handoff";

export async function POST(request) {
  const pool=getPostgresPool();
  if(!pool)return NextResponse.json({error:"Service unavailable"},{status:503});
  try{
    await authenticateWidgetHandoff(pool,request.headers.get("telnyx-ai-api-key"));
    const reader=request.body?.getReader();
    if(!reader)throw Object.assign(new Error("Invalid request body"),{status:400});
    const chunks=[];let length=0;
    while(true){
      const {value,done}=await reader.read();if(done)break;
      length+=value.byteLength;
      if(length>32768){await reader.cancel();throw Object.assign(new Error("Request body too large"),{status:413});}
      chunks.push(Buffer.from(value));
    }
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}
    catch{throw Object.assign(new Error("Invalid JSON body"),{status:400});}
    const result=await handoffWidgetChat(pool,{body,sessionToken:request.headers.get("x-cc-widget-handoff-token")});
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(error){
    return NextResponse.json({ok:false,error:error.status?error.message:"Unable to hand off chat"},
      {status:error.status||500,headers:{"Cache-Control":"no-store"}});
  }
}
