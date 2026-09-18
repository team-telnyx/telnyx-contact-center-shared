import { markerSamples,encodeWav,MARKERS } from '@/lib/call-generator/test-audio.mjs';
export async function GET(_request,{params}) {
  const {marker}=await params;
  if(process.env.CC_LIVE_VOICE_TESTS!=='true'||!Object.hasOwn(MARKERS,marker))return new Response(null,{status:404});
  return new Response(encodeWav(markerSamples(marker)),{headers:{'Content-Type':'audio/wav','Cache-Control':'public, max-age=3600'}});
}
