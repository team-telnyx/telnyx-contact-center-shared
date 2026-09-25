import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getPublishedWidget } from "@/lib/widgets/store";
import { isWidgetOriginAllowed } from "@/lib/widgets/config";
import { verifyWidgetTestGrant } from "@/lib/widgets/session-tokens";
import { buildWidgetBootstrapPayload } from "@/lib/widgets/bootstrap-payload";

async function bootstrap(request,context){
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Service unavailable"},{status:503});
  const {publicId}=await context.params;
  const widget=await getPublishedWidget(pool,publicId);
  if(!widget)return NextResponse.json({error:"Widget not found"},{status:404});
  let origin=request.headers.get("origin");
  if(!origin){try{origin=new URL(request.headers.get("referer")||request.url).origin;}catch{origin=null;}}
  // The signed-in test page passes a grant instead of relying on the allowlist;
  // its sessions are stored under a marked origin so test traffic stays recognisable.
  const grant=origin?verifyWidgetTestGrant(new URL(request.url).searchParams.get("grant"),{publicId,origin}):null;
  if(!origin||!(grant||isWidgetOriginAllowed(origin,widget.config.allowedOrigins)))return NextResponse.json({error:"Embedding origin is not allowed"},{status:403});
  const headers={"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"GET, OPTIONS",
    "Access-Control-Allow-Headers":"content-type","Access-Control-Max-Age":"600","Cache-Control":"no-store",Vary:"Origin"};
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers});
  try{
    return NextResponse.json(buildWidgetBootstrapPayload(widget,{publicId,origin,testGrant:Boolean(grant)}),{headers});
  }catch{return NextResponse.json({error:"Widget could not be initialized"},{status:503,headers});}
}
export const GET=bootstrap;
export const OPTIONS=bootstrap;
