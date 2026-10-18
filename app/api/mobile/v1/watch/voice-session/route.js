import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/authz/guard';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { issueWatchAudioTicket } from '@/lib/watch-audio/sessions.mjs';
import { resolveWatchTarget } from '@/lib/watch-audio/outbound-targets.mjs';
export const runtime='nodejs';
export const POST=withPermission('agent:self',async(request,_context,authz)=>{
  try {
    if(!process.env.TELNYX_API_KEY) return NextResponse.json({error:'Voice service unavailable.'},{status:503});
    const pool=getPostgresPool();
    const target=await resolveWatchTarget(pool,authz.user,await request.json());
    const ticket=await issueWatchAudioTicket(pool,authz.user,'voice',process.env,target);
    return NextResponse.json({...ticket,name:target.name},{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    const status=error.status || 503;
    return NextResponse.json({error:status<500?error.message:'Watch calling is temporarily unavailable.'},{status});
  }
},{route:'/api/mobile/v1/watch/voice-session'});
