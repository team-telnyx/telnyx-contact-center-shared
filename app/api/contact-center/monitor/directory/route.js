import { NextResponse } from 'next/server';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { withPermission } from '@/lib/authz/guard';
import { readMobileInteractionDirectory } from '@/lib/acd/mobile-interaction-directory.mjs';
async function handler(request,context,authz) {
  let db;
  try {
    db=await getPostgresPool().connect();
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await readMobileInteractionDirectory(db,new URL(request.url).searchParams,authz.scope);
    await db.query('COMMIT');
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    if(db) await db.query('ROLLBACK');
    return NextResponse.json({error:error.status===400?error.message:'Unable to load supervisor data'}, {status:error.status===400?400:500});
  } finally { db?.release(); }
}
export const GET=withPermission('monitor:read',handler,{route:'/api/contact-center/monitor/directory'});
