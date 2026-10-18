import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/authz/guard';
import { FASTROUTER_BASE_URL, normalizeFastRouterCatalog } from '@/lib/ai/model-providers.mjs';

export const GET = withPermission('ai_models:read', async () => {
  try {
    // Public catalog. No Telnyx key or vaulted provider secret leaves this server.
    const response = await fetch(`${FASTROUTER_BASE_URL}/models`, {cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok) return NextResponse.json({ok:false,error:`FastRouter catalog unavailable (${response.status})`},{status:502});
    const body=await response.text();
    if(body.length>5_000_000)throw new Error('Catalog exceeds size limit');
    return NextResponse.json({ok:true,models:normalizeFastRouterCatalog(JSON.parse(body))},{headers:{'Cache-Control':'no-store'}});
  } catch {
    return NextResponse.json({ok:false,error:'Could not load the FastRouter model catalog. Retry or enter a model ID.'},{status:502});
  }
},{route:'/api/ai/models/fastrouter'});
