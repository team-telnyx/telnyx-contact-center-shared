import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { buildTelnyxV2Url } from "@/lib/telnyx.js";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

const DEFAULT_SETTINGS = {
  enabled: false,
  max_concurrent_calls: 10,
  max_cps: 2,
  from_numbers: [],
  dial_timeout_secs: 30,
  max_call_duration_secs: 120,
  pstn_whitelist: [],
};

function normalizeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    max_concurrent_calls: clampInt(value.max_concurrent_calls, 1, 100, DEFAULT_SETTINGS.max_concurrent_calls),
    max_cps: clampInt(value.max_cps, 1, 20, DEFAULT_SETTINGS.max_cps),
    from_numbers: Array.isArray(value.from_numbers)
      ? value.from_numbers.map((n) => String(n || "").trim()).filter(Boolean).slice(0, 50)
      : [],
    dial_timeout_secs: clampInt(value.dial_timeout_secs, 10, 120, DEFAULT_SETTINGS.dial_timeout_secs),
    max_call_duration_secs: clampInt(value.max_call_duration_secs, 10, 3600, DEFAULT_SETTINGS.max_call_duration_secs),
    pstn_whitelist: Array.isArray(value.pstn_whitelist)
      ? value.pstn_whitelist.map((n) => String(n || "").trim()).filter(Boolean).slice(0, 100)
      : [],
  };
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

// Same inventory pattern as the Outbound Dialer: list active phone numbers
// on the Telnyx account so settings can offer a multiselect of CLIs.
async function loadInventoryNumbers() {
  if (!process.env.TELNYX_API_KEY) return [];
  try {
    const pageSize = 250;
    const numbers = [];
    const seen = new Set();
    for (let page = 1; ; page += 1) {
      const params = new URLSearchParams();
      params.set("page[size]", String(pageSize));
      params.set("page[number]", String(page));
      params.set("filter[status]", "active");
      const res = await fetch(`${buildTelnyxV2Url("/phone_numbers")}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Telnyx inventory page ${page} failed with ${res.status}`);
      const data = await res.json();
      const rows = Array.isArray(data?.data) ? data.data : [];
      for (const item of rows) {
        if (!item?.phone_number || seen.has(item.phone_number)) continue;
        seen.add(item.phone_number);
        numbers.push({
          id: item.id,
          phone_number: item.phone_number || null,
          status: item.status || null,
          connection_name: item.connection_name || null,
          country_code: item.country_code || null,
        });
      }
      const currentPage = Number(data?.meta?.page_number || data?.meta?.page?.number || page);
      const totalPages = Number(data?.meta?.total_pages || data?.meta?.page?.total_pages || 0);
      if (rows.length < pageSize || (totalPages && currentPage >= totalPages)) break;
    }
    return numbers;
  } catch (err) {
    adminRuntimeLogger.warn("call_generator_inventory_load_failed", runtimePayload({ error: err, operation: "cg_inventory_numbers" }));
    return [];
  }
}

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const [{ rows }, inventoryNumbers] = await Promise.all([
      pool.query(`SELECT settings FROM cg_settings WHERE id = 'default' LIMIT 1`),
      loadInventoryNumbers(),
    ]);
    const settings = normalizeSettings(rows[0]?.settings);
    return NextResponse.json({ settings, inventoryNumbers });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_settings_load_failed", runtimePayload({ error: err, operation: "cg_settings_get" }));
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

export async function PUT(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json();
    const settings = normalizeSettings(body?.settings || body);
    await pool.query(
      `INSERT INTO cg_settings (id, settings, updated_at) VALUES ('default', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET settings = $1, updated_at = NOW()`,
      [JSON.stringify(settings)],
    );
    return NextResponse.json({ ok: true, settings });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_settings_save_failed", runtimePayload({ error: err, operation: "cg_settings_put" }));
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
