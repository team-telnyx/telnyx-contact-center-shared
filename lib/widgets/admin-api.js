import { NextResponse } from "next/server";
import { requirePermission, authzErrorResponse, AuthzError } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";

const PERMISSION_BY_METHOD = { GET: "widgets:read", HEAD: "widgets:read", POST: "widgets:create", PUT: "widgets:update", PATCH: "widgets:update", DELETE: "widgets:delete" };

/**
 * Widget administration wrapper. The permission defaults to the HTTP method
 * (read / create / update / delete on `widgets`); pass `permission` for
 * actions such as publishing. Legacy predicate: administrators.
 */
export async function withWidgetAdmin(request, operation, { permission } = {}) {
  let authz;
  try {
    authz = await requirePermission(permission || PERMISSION_BY_METHOD[request.method] || "widgets:update", { request, route: "/api/admin/widgets" });
  } catch (error) {
    if (error instanceof AuthzError) return authzErrorResponse(error);
    throw error;
  }
  const user = authz.user;
  if(!["GET","HEAD"].includes(request.method)){
    const origin=request.headers.get("origin");
    // Next may expose an internal hostname in request.url behind its proxy.
    // Compare the browser origin with the actual HTTP Host as well.
    let sameOrigin=!origin;
    try{sameOrigin ||= origin===new URL(request.url).origin || /^https?:$/.test(new URL(origin).protocol) && new URL(origin).host===request.headers.get("host");}catch{}
    if(!sameOrigin)return NextResponse.json({error:"Cross-origin administration is not allowed"},{status:403});
  }
  const pool=getPostgresPool();
  if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{return await operation({pool,actor:String(user.id),user,authz});}
  catch(error){
    const issues=error.issues?.map(issue=>({path:issue.path.join("."),message:issue.message}));
    return NextResponse.json({error:issues?"Invalid widget configuration":error.status?error.message:"Widget operation failed",...(issues?{issues}:{})},
      {status:issues?400:error.status||500});
  }
}
