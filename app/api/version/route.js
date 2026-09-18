import { APP_BUILD } from "@/lib/app-version.mjs";

export const dynamic = "force-dynamic";

// Public build metadata only. No database or provider connection is needed.
export function GET() {
  return Response.json(APP_BUILD || { error: "Version information unavailable" }, {
    status: APP_BUILD ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
