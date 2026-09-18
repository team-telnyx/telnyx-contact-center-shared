import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { geocodeSearch } from "@/lib/contact-center/geocoding.mjs";
import { withPermission } from "@/lib/authz/guard";

// Agent-facing address search for the WhatsApp "send location" dialog. The
// geocoder is called from the server only, throttled and cached.
async function GET_handler(request){
  const user=await getAuthenticatedUser();if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const params=new URL(request.url).searchParams;
  try{
    const results=await geocodeSearch(params.get("q"),{language:request.headers.get("accept-language")||""});
    return NextResponse.json({results},{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return NextResponse.json({error:error.status?error.message:"Address search failed"},{status:error.status||500});}
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/media/geocode" });
