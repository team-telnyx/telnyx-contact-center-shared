import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

function appendFilter(sp, key, value) {
  if (value == null || value === "") return;
  sp.append(`filter[${key}]`, String(value));
}

export async function GET(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const urlObj = new URL(request.url);
    const page = Number(urlObj.searchParams.get("page") || 1);
    const pageSize = Number(urlObj.searchParams.get("pageSize") || 50);
    const q = (urlObj.searchParams.get("q") || "").trim(); // partial digits
    const tag = (urlObj.searchParams.get("tag") || "").trim();
    const numberType = (urlObj.searchParams.get("numberType") || "").trim(); // local|mobile|national|toll_free|shared_cost
    const messagingFilter = (urlObj.searchParams.get("messagingFilter") || "").trim(); // Special filter for messaging: "mobile_or_us"
    const assigned = (urlObj.searchParams.get("assigned") || "").trim(); // 'unassigned' or ''
    const assignedType = (urlObj.searchParams.get("assignedType") || "").trim(); // 'voice' or 'messaging' - determines which assignment to check for unassigned filter
    const connectionId = (urlObj.searchParams.get("connectionId") || "").trim(); // filter by connection_id
    const messagingProfileId = (
      urlObj.searchParams.get("messagingProfileId") || ""
    ).trim(); // filter by messaging_profile_id

    const upstream = new URL(buildTelnyxV2Url("/phone_numbers"));
    upstream.searchParams.set("page[number]", String(page));
    // For queries starting with "+", use larger page size to improve client-side filtering
    // This helps ensure we get matching results when filtering client-side
    const effectivePageSize = q && q.trim().startsWith("+")
      ? Math.min(Math.max(pageSize, 1), 200) // Use max page size for "+" queries
      : Math.min(Math.max(pageSize, 1), 200);
    upstream.searchParams.set("page[size]", String(effectivePageSize));

    // Filters per OpenAPI spec (deepObject style flattened)
    // Note: We'll apply phone number filtering client-side for better control
    // For queries starting with "+", skip API filter and filter entirely client-side
    // This ensures prefix matching works correctly (e.g., "+44" matches "+442...")
    // For non-"+", use API filter to reduce results before client-side filtering
    if (q && q.trim().length >= 3) {
      const queryTrimmed = q.trim();
      // Only apply API filter if query doesn't start with "+"
      // For "+" prefix queries, we need to filter client-side to ensure correct prefix matching
      if (!queryTrimmed.startsWith("+")) {
        const digitsOnly = queryTrimmed.replace(/\D/g, "");
        if (digitsOnly.length >= 3) {
          // Try to use contains filter if available, otherwise use basic filter
          // Note: Telnyx /phone_numbers endpoint might not support [contains], so we use basic filter
          appendFilter(upstream.searchParams, "phone_number", digitsOnly);
        }
      }
      // If query starts with "+", we'll filter entirely client-side after fetching
    }
    if (tag) appendFilter(upstream.searchParams, "tag", tag);
    // For messaging filter, we don't set numberType here - we'll filter client-side
    // For regular numberType filter, apply it normally
    if (numberType && messagingFilter !== "mobile_or_us") {
      upstream.searchParams.append("filter[number_type][eq]", numberType);
    }
    if (connectionId)
      appendFilter(upstream.searchParams, "connection_id", connectionId);
    if (messagingProfileId)
      appendFilter(
        upstream.searchParams,
        "messaging_profile_id",
        messagingProfileId
      );

    const res = await fetch(upstream.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: data?.errors?.[0]?.detail || `Telnyx ${res.status}`,
        },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    let items = Array.isArray(data?.data) ? data.data : [];

    // Apply phone number filter (digits query)
    // If query starts with "+", match numbers that start with that prefix
    // Otherwise, match numbers that contain the digits
    if (q && q.trim().length >= 3) {
      const queryTrimmed = q.trim();
      if (queryTrimmed.startsWith("+")) {
        // Starts with prefix match (e.g., "+13" matches "+1312...")
        items = items.filter((n) => {
          const phoneNumber = String(n?.phone_number || "");
          return phoneNumber.startsWith(queryTrimmed);
        });
      } else {
        // Contains digits match (e.g., "13" matches any number containing "13")
        const digitsOnly = queryTrimmed.replace(/\D/g, "");
        if (digitsOnly.length >= 3) {
          items = items.filter((n) => {
            const phoneNumber = String(n?.phone_number || "").replace(/\D/g, "");
            return phoneNumber.includes(digitsOnly);
          });
        }
      }
    }

    // Apply messaging filter: show mobile numbers OR US numbers (+1)
    if (messagingFilter === "mobile_or_us") {
      items = items.filter((n) => {
        const phoneNumber = n?.phone_number || "";
        const numberType = n?.phone_number_type || n?.number_type || "";
        // Include if it's mobile type OR if it's a US number (+1)
        return numberType === "mobile" || phoneNumber.startsWith("+1");
      });
    }

    // Apply assigned filter
    // A number is "unassigned" if the "Assigned To" column would show "—"
    // This means both the name and ID must be empty/null/undefined/empty string
    const filteredItems =
      assigned === "unassigned"
        ? items.filter((n) => {
            // Helper to check if a value is truly empty
            const isEmpty = (val) => {
              if (val == null) return true;
              const str = String(val).trim();
              return str === "" || str === "—" || str === "null" || str === "undefined";
            };

            // If assignedType is "messaging", check messaging assignment
            if (assignedType === "messaging") {
              const messagingId =
                n?.messaging_profile_id ||
                n?.messaging?.messaging_profile_id ||
                null;
              const messagingNameRaw =
                n?.messaging_profile_name ||
                n?.messaging?.messaging_profile_name ||
                null;
              // Unassigned if both name and ID are empty (would display "—")
              return isEmpty(messagingNameRaw) && isEmpty(messagingId);
            }
            // If assignedType is "voice" or not specified (default for Calling tab), check connection assignment
            const connectionId =
              n?.connection_id || n?.voice?.connection_id || null;
            const connectionName =
              n?.connection_name || n?.voice?.connection_name || null;
            // Unassigned if both name and ID are empty (would display "—")
            return isEmpty(connectionName) && isEmpty(connectionId);
          })
        : items;
    const meta = data?.meta || {};
    // Update total_results to reflect filtered count if we applied client-side filters
    // This ensures pagination works correctly
    if (q || assigned === "unassigned" || messagingFilter === "mobile_or_us") {
      meta.total_results = filteredItems.length;
      meta.total = filteredItems.length;
    }
    return NextResponse.json(
      { ok: true, items: filteredItems, meta },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
