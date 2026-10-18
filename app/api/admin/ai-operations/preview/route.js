import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/authz/guard';
import { operationSample, buildOperationPreview } from '@/lib/ai-operations/playground.mjs';
import { platformDefaultModel } from '@/lib/ai-operations/runtime.mjs';
export const dynamic='force-dynamic';
async function GET_handler(request){
 try{return NextResponse.json({sample:operationSample(new URL(request.url).searchParams.get('id'))},{headers:{'Cache-Control':'no-store'}});}
 catch{return NextResponse.json({error:'Unknown AI operation.'},{status:400});}
}
async function POST_handler(request){
 try{
  const raw=await request.text();
  if(raw.length>60000)return NextResponse.json({error:'Keep the complete preview within 60,000 characters.'},{status:400});
  const {model:defaultModel}=await platformDefaultModel();
  return NextResponse.json(buildOperationPreview(JSON.parse(raw),{defaultModel}),{headers:{'Cache-Control':'no-store'}});
 }catch(error){return NextResponse.json({error:error.issues?'Check the operation, model, instructions and sample JSON.':error.message||'Invalid sample context.'},{status:400});}
}
export const GET=withPermission('system_settings:read',GET_handler,{route:'/api/admin/ai-operations/preview'});
export const POST=withPermission('system_settings:read',POST_handler,{route:'/api/admin/ai-operations/preview'});
