import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  createMobileSetupQrDataUrl,
  mobileAppSetupFromEnvironment,
} from "@/lib/mobile-app-setup.mjs";

async function GET_handler() {
  const pool = getPostgresPool();
  if (!pool) {
    return NextResponse.json(
      { ok: false, error: "Server not ready" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await pool.query(
    "SELECT brand_name FROM app_settings WHERE id = 'default' LIMIT 1",
  );
  const setup = mobileAppSetupFromEnvironment({
    organizationName: result.rows[0]?.brand_name,
  });
  const qrCodeDataUrl = await createMobileSetupQrDataUrl(setup.setupLink);

  return NextResponse.json(
    { ok: true, ...setup, qrCodeDataUrl },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = withPermission("authenticated", GET_handler, {
  route: "/api/user/mobile-app-setup",
});
