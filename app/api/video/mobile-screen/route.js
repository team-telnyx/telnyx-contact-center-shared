import {NextResponse} from 'next/server';
import {getPostgresPool} from '@/lib/postgres.mjs';
import {validateMobileScreenGrant,refreshMobileScreenGrant} from '@/lib/video/mobile-screen.mjs';

// ReplayKit receives only a signed capability for one active assignment, never
// the user's login/session or Telnyx API key. Revalidated every 15 seconds.
export async function POST(request) {
 const pool=getPostgresPool();
 if(!pool)return NextResponse.json({error:'Database unavailable'},{status:503});
 try {
  const body=await request.json();
  const capability=request.headers.get('x-cc-video-screen');
  const join=body.refreshToken ? await refreshMobileScreenGrant(pool,{capability,refreshToken:body.refreshToken}) :
    (await validateMobileScreenGrant(pool,capability),null);
  return NextResponse.json({ok:true,...(join?{join}:{})},{headers:{'Cache-Control':'no-store'}});
 } catch(error) {return NextResponse.json({error:error.status?error.message:'Screen sharing unavailable'},{status:error.status||500});}
}
