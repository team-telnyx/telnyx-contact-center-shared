import { NextResponse } from "next/server";
import { resolveSecretReferences } from "@/lib/secrets.js";
import { assertPublicHostname } from "@/lib/security/outbound-url.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

import { withPermission } from "@/lib/authz/guard";
function parseResponseBody(responseText, contentType = "") {
  if (!responseText.trim()) {
    return null;
  }

  if (contentType.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(responseText);
    } catch {
      return responseText;
    }
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

async function POST_handler(request) {
  try {
    const config = await request.json();
    const {
      url,
      method = "GET",
      headers = {},
      pathParams = {},
      queryParams = {},
      body = "",
      timeout = 30000,
    } = config || {};

    if (!url) {
      return NextResponse.json(
        { success: false, error: "URL is required" },
        { status: 400 },
      );
    }

    let requestUrl = await resolveSecretReferences(String(url));
    for (const [key, value] of Object.entries(pathParams || {})) {
      const resolvedValue = await resolveSecretReferences(String(value ?? ""));
      requestUrl = requestUrl.replace(
        new RegExp(`\\{${key}\\}`, "g"),
        encodeURIComponent(resolvedValue),
      );
    }

    const urlObject = new URL(requestUrl);
    // The test request is made from the server: only public http(s) targets
    // are allowed, never loopback, link-local, private ranges or metadata hosts.
    if (!/^https?:$/.test(urlObject.protocol)) {
      return NextResponse.json({ success: false, error: "Only http and https URLs can be tested" }, { status: 400 });
    }
    try {
      await assertPublicHostname(urlObject.hostname);
    } catch (policyError) {
      return NextResponse.json({ success: false, error: policyError?.message || "The URL is not allowed" }, { status: 400 });
    }
    for (const [key, value] of Object.entries(queryParams || {})) {
      if (value !== undefined && value !== null && value !== "") {
        const resolvedValue = await resolveSecretReferences(String(value));
        urlObject.searchParams.set(key, resolvedValue);
      }
    }

    const resolvedHeaders = {};
    for (const [key, value] of Object.entries(headers || {})) {
      resolvedHeaders[key] = await resolveSecretReferences(String(value ?? ""));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Number(timeout) || 30000);

    const fetchOptions = {
      method,
      headers: resolvedHeaders,
      signal: controller.signal,
    };

    if (method !== "GET" && body !== undefined && body !== null && body !== "") {
      fetchOptions.body = await resolveSecretReferences(String(body));
    }

    try {
      const response = await fetch(urlObject.toString(), fetchOptions);
      clearTimeout(timeoutId);

      const responseText = await response.text();
      const contentType = response.headers.get("content-type") || "";
      const parsedBody = parseResponseBody(responseText, contentType);

      return NextResponse.json({
        success: response.ok,
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: parsedBody,
          rawBody: responseText,
        },
        error: response.ok
          ? undefined
          : `HTTP ${response.status} ${response.statusText}`.trim(),
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        return NextResponse.json(
          { success: false, error: "HTTP request timeout" },
          { status: 408 },
        );
      }
      throw error;
    }
  } catch (error) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { success: false, error: error.message || "Failed to test HTTP request" },
      { status: 500 },
    );
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("call_flows:test", POST_handler, { route: "/api/voice/flows/test-http-request" });
