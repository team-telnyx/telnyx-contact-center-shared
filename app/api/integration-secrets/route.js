import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";


async function GET_handler(_request, _context, authz) {
  const user = authz.user;

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Missing TELNYX_API_KEY" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const pageSize = 250;
    let pageNumber = 1;
    const allSecrets = [];

    for (let safety = 0; safety < 10; safety += 1) {
      const url = buildTelnyxV2Url(
        `/integration_secrets?page[number]=${pageNumber}&page[size]=${pageSize}`,
      );
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return NextResponse.json(
          {
            ok: false,
            error: data?.errors?.[0]?.detail || `Telnyx API error: ${res.status}`,
          },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }

      const data = await res.json().catch(() => ({}));
      const chunk = Array.isArray(data?.data) ? data.data : [];
      allSecrets.push(
        ...chunk.map((secret) => ({
          id: secret?.id || "",
          identifier: secret?.identifier || "",
          type: secret?.type || "",
          created_at: secret?.created_at || secret?.createdAt || undefined,
        })),
      );

      const totalPages = data?.meta?.total_pages;
      const currentPage = data?.meta?.page_number || pageNumber;
      if (chunk.length < pageSize) break;
      if (totalPages && currentPage >= totalPages) break;
      pageNumber += 1;
    }

    return NextResponse.json(
      { ok: true, secrets: allSecrets },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("secrets:read", GET_handler, { route: "/api/integration-secrets" });

export const POST = withPermission('secrets:create', async (request) => {
  const body=await request.json().catch(()=>null);
  if(!body||body.type!=='bearer'||typeof body.identifier!=='string'||!body.identifier.trim()||typeof body.token!=='string'||!body.token) {
    return NextResponse.json({ok:false,error:'A secret identifier and bearer token are required.'},{status:400});
  }
  if(!process.env.TELNYX_API_KEY)return NextResponse.json({ok:false,error:'Missing TELNYX_API_KEY'},{status:500});
  try {
    const response=await fetch(buildTelnyxV2Url('/integration_secrets'),{method:'POST',headers:{Authorization:`Bearer ${process.env.TELNYX_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({identifier:body.identifier.trim(),type:'bearer',token:body.token}),signal:AbortSignal.timeout(15000),cache:'no-store'});
    // Do not echo an upstream validation response: it can contain submitted credentials.
    if(!response.ok)return NextResponse.json({ok:false,error:`Telnyx could not create the secret (${response.status}). Check its identifier and your permissions.`},{status:response.status===422?400:502});
    const data=await response.json();const secret=data.data||data;
    return NextResponse.json({ok:true,secret:{id:secret.id,identifier:secret.identifier,type:secret.type}},{headers:{'Cache-Control':'no-store'}});
  }catch{return NextResponse.json({ok:false,error:'Could not create the integration secret.'},{status:502});}
},{route:'/api/integration-secrets'});
