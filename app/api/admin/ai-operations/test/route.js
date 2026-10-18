import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/authz/guard';
import { readPlaygroundInput, runOperationTest } from '@/lib/ai-operations/playground-service.mjs';
import { platformDefaultModel } from '@/lib/ai-operations/runtime.mjs';
export const dynamic='force-dynamic';
export const maxDuration=70;
async function POST_handler(request){
 try{const {model:defaultModel}=await platformDefaultModel();return NextResponse.json(await runOperationTest(await readPlaygroundInput(request),{signal:request.signal,defaultModel}),{headers:{'Cache-Control':'no-store'}});}
 catch(error){return NextResponse.json({error:error.message,providerStatus:error.providerStatus},{status:error.status||500});}
}
export const POST=withPermission('system_settings:update',POST_handler,{route:'/api/admin/ai-operations/test'});
