import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { describeCatalogue } from "@/lib/authz/permissions.mjs";
import { describeAccess } from "@/lib/authz/effective.mjs";

export const dynamic = "force-dynamic";

/**
 * The permission catalogue for the role editor, plus the caller's own access so
 * the editor can lock grants outside it (delegation rule).
 */
export const GET = withPermission(
  ["roles:read", "roles:manage", "users:read"],
  async (request, context, { access }) => {
    return NextResponse.json({ catalogue: describeCatalogue(), actor: describeAccess(access), mode: "enforce" }, { headers: { "Cache-Control": "private, no-store" } });
  },
  { route: "/api/admin/permissions" },
);
