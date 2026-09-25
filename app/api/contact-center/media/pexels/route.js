import { NextResponse } from "next/server";
import { pexelsSearch, pexelsDownload, pexelsConfigured } from "@/lib/pexels.mjs";
import { withPermission } from "@/lib/authz/guard";

// Agent-facing Pexels proxy: search royalty-free photos and fetch one as an
// image the composer attaches like any other file. Requires a signed-in user.
async function GET_handler(request){
  const params=new URL(request.url).searchParams;
  try{
    if(params.has("photoId")){
      const file=await pexelsDownload(params.get("photoId"));
      return new Response(file.bytes,{headers:{"content-type":file.contentType,"content-length":String(file.bytes.length),"content-disposition":`inline; filename="${file.filename}"`,
        "x-pexels-filename":file.filename,"x-pexels-photographer":encodeURIComponent(file.photo.photographer||""),"cache-control":"private, no-store","x-content-type-options":"nosniff"}});
    }
    if(!pexelsConfigured())return NextResponse.json({error:"Pexels is not configured on the server"},{status:503});
    return NextResponse.json(await pexelsSearch({query:params.get("query"),page:params.get("page")||1,perPage:params.get("perPage")||30,orientation:params.get("orientation")||""}),{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return NextResponse.json({error:error.status?error.message:"Pexels request failed"},{status:error.status||500});}
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/media/pexels" });
