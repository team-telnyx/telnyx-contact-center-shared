import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { PgDb } from "@/lib/pgdb";
import { getAuthenticatedUser } from "@/lib/auth-server";

export async function GET(request, { params }) {
  try {
    const telnyxApiKey = process.env.TELNYX_API_KEY;
    if (!telnyxApiKey) {
      return NextResponse.json(
        { error: "Server not configured" },
        { status: 500 }
      );
    }

    const { phone: phoneParam } = await params;
    const phone = (phoneParam || "").trim();
    if (!phone) {
      return NextResponse.json(
        { error: "Missing phone number" },
        { status: 400 }
      );
    }

    const urlObj = new URL(request.url);
    const typesParam = urlObj.searchParams.get("types");
    const types = (typesParam || "carrier,caller_name").trim();

    const upstreamUrl = new URL(
      buildTelnyxV2Url(`/number_lookup/${encodeURIComponent(phone)}`)
    );
    if (types) {
      types.split(",").forEach((type) => {
        upstreamUrl.searchParams.append("type", type.trim());
      });
    }

    const resp = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    const data = await resp.json().catch(() => ({}));

    // Log the lookup if user is authenticated
    try {
      const user = await getAuthenticatedUser();
      const username = user?.username || null;

      if (username) {
        const base = {
          username,
          phone,
          carrierLookup: /(^|,)\s*carrier\s*(,|$)/i.test(types || ""),
          callerNameLookup: /(^|,)\s*caller_name\s*(,|$)/i.test(types || ""),
          payload: data,
        };
        if (!resp.ok) {
          await PgDb.insertNumberLookup({
            ...base,
            success: false,
            status: String(resp.status || "error"),
            errorMessage: data?.errors?.[0]?.detail || "Lookup failed",
          });
        } else {
          await PgDb.insertNumberLookup({
            ...base,
            success: true,
            status: "ok",
          });
        }
      }
    } catch (_) {}

    if (!resp.ok) {
      const status = resp.status || 502;
      return NextResponse.json(
        { error: data?.errors?.[0]?.detail || "Lookup failed", details: data },
        { status }
      );
    }

    return NextResponse.json({ ok: true, data: data?.data || data });
  } catch (err) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
