import { NextResponse } from 'next/server';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { withPermission } from '@/lib/authz/guard';
import { readMobileDialerPage } from '@/lib/outbound-dialer/mobile-pages.mjs';
async function handler(request,context,authz) {
  let db;
  try {
    db=await getPostgresPool().connect();
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await readMobileDialerPage(db,new URL(request.url).searchParams,authz.scope);
    await db.query('COMMIT');
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    if(db) await db.query('ROLLBACK');
    return NextResponse.json({error:error.status===400?error.message:'Unable to load supervisor data'}, {status:error.status===400?400:500});
  } finally { db?.release(); }
}
export const GET=withPermission('campaigns:read',handler,{route:'/api/contact-center/outbound-dialer/mobile'});
