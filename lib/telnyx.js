// Centralized Telnyx API base and URL builders

function normalizeBase(base) {
  if (!base) return "https://api.telnyx.com";
  try {
    const u = new URL(base);
    // Drop trailing slash for consistent join
    return u.origin + u.pathname.replace(/\/$/, "");
  } catch {
    // If invalid URL in env, fall back to default
    return "https://api.telnyx.com";
  }
}

export function getTelnyxBasePath() {
  // Prefer explicit TELNYX_BASE_PATH, else default to public endpoint
  const fromEnv = process.env.TELNYX_BASE_PATH;
  return normalizeBase(fromEnv);
}

export function buildTelnyxUrl(path = "") {
  const base = getTelnyxBasePath();
  const joined = String(path || "");
  if (!joined) return base;
  if (joined.startsWith("http://") || joined.startsWith("https://"))
    return joined;
  const needsSlash = !base.endsWith("/") && !joined.startsWith("/");
  return `${base}${needsSlash ? "/" : ""}${joined}`;
}

export function buildTelnyxV2Url(path = "") {
  const baseV2 = buildTelnyxUrl("/v2");
  const suffix = String(path || "");
  if (!suffix) return baseV2;
  const needsSlash = !baseV2.endsWith("/") && !suffix.startsWith("/");
  return `${baseV2}${needsSlash ? "/" : ""}${suffix}`;
}

/**
 * Get call_session_id from call_control_id
 * @param {string} callControlId - The call control ID
 * @param {string} apiKey - Telnyx API key
 * @returns {Promise<string|null>} - The call_session_id or null if not found
 */
export async function getCallSessionId(callControlId, apiKey) {
  if (!callControlId || !apiKey) {
    return null;
  }

  try {
    const url = buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}`);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const callInfo = data.data || data;
    return callInfo.call_session_id || callInfo.callSessionId || null;
  } catch (error) {
    console.error("[Telnyx] Error fetching call_session_id:", error);
    return null;
  }
}

/**
 * Fetch recordings by call_session_id or call_control_id
 * @param {Object} options - Options for fetching recordings
 * @param {string} [options.callSessionId] - Call session ID to filter by
 * @param {string} [options.callControlId] - Call control ID (will fetch call_session_id first)
 * @param {string} apiKey - Telnyx API key
 * @param {Object} [options.additionalParams] - Additional query parameters to pass through
 * @returns {Promise<Object>} - Response with { ok: boolean, data: Array, meta: Object }
 */
export async function fetchRecordings({
  callSessionId,
  callControlId,
  apiKey,
  additionalParams = {},
}) {
  if (!apiKey) {
    throw new Error("Telnyx API key is required");
  }

  let sessionId = callSessionId;

  // If call_control_id is provided, fetch call_session_id first
  if (callControlId && !sessionId) {
    sessionId = await getCallSessionId(callControlId, apiKey);
    if (!sessionId) {
      return {
        ok: false,
        error: "Call session ID not found for the provided call control ID",
        data: [],
        meta: {},
      };
    }
  }

  if (!sessionId) {
    return {
      ok: false,
      error: "Either call_session_id or call_control_id must be provided",
      data: [],
      meta: {},
    };
  }

  // Build query parameters
  const params = new URLSearchParams();
  params.set("filter[call_session_id]", sessionId);

  // Add additional parameters
  Object.entries(additionalParams).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      params.set(key, String(value));
    }
  });

  try {
    const url = buildTelnyxV2Url(`/recordings?${params.toString()}`);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Telnyx] Error fetching recordings:", errorText);
      return {
        ok: false,
        error: "Failed to fetch recordings from Telnyx",
        data: [],
        meta: {},
      };
    }

    const data = await response.json();
    return {
      ok: true,
      data: data?.data || [],
      meta: data?.meta || {},
    };
  } catch (error) {
    console.error("[Telnyx] Error fetching recordings:", error);
    return {
      ok: false,
      error: "Failed to fetch recordings",
      data: [],
      meta: {},
    };
  }
}
