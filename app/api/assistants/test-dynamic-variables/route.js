/**
 * Test Dynamic Variables Webhook
 * POST /api/assistants/test-dynamic-variables
 *
 * Tests a dynamic variables webhook with the correct payload format and authentication
 */

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isAdmin } from "@/lib/role-utils";
import { platformApiLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { assertPublicHostname } from "@/lib/security/outbound-url.mjs";

function configuredWebhookUrls() {
  return String(process.env.DYNAMIC_VARIABLE_WEBHOOK_TEST_ALLOWED_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        const configuredUrl = new URL(value);
        if (
          !["http:", "https:"].includes(configuredUrl.protocol) ||
          configuredUrl.username ||
          configuredUrl.password
        ) {
          return [];
        }
        return [configuredUrl.toString()];
      } catch {
        return [];
      }
    });
}

export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user || !isAdmin(user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { url, payload } = await request.json();

    if (!url) {
      return NextResponse.json(
        { error: "Webhook URL is required" },
        { status: 400 }
      );
    }

    let targetUrl;
    try {
      targetUrl = new URL(String(url));
    } catch {
      return NextResponse.json({ error: "Webhook URL is invalid" }, { status: 400 });
    }

    if (
      !["http:", "https:"].includes(targetUrl.protocol) ||
      targetUrl.username ||
      targetUrl.password
    ) {
      return NextResponse.json(
        { error: "Webhook URL must use HTTP(S) without embedded credentials" },
        { status: 400 }
      );
    }

    let configuredTarget;
    for (const allowedUrl of configuredWebhookUrls()) {
      if (allowedUrl === targetUrl.toString()) {
        configuredTarget = allowedUrl;
        break;
      }
    }

    if (!configuredTarget) {
      return NextResponse.json(
        {
          error:
            "Webhook URL is not allowed. Configure DYNAMIC_VARIABLE_WEBHOOK_TEST_ALLOWED_URLS.",
        },
        { status: 400 }
      );
    }

    const configuredUrl = new URL(configuredTarget);
    const targetHostname = configuredUrl.hostname.toLowerCase().replace(/\.$/, "");

    try {
      await assertPublicHostname(targetHostname);
    } catch (error) {
      return NextResponse.json(
        { error: error.message || "Webhook hostname is not publicly routable" },
        { status: 400 }
      );
    }

    const apiKey = process.env.TELNYX_AI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing TELNYX_AI_API_KEY environment variable" },
        { status: 500 }
      );
    }

    // Make the request to the dynamic variables webhook
    const response = await fetch(configuredTarget, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "telnyx-ai-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    let responseBody;
    const contentType = response.headers.get("content-type");

    if (contentType && contentType.includes("application/json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          error: `Request failed with status ${response.status}`,
          status: response.status,
          body: responseBody,
        },
        { status: response.status }
      );
    }

    return NextResponse.json({
      success: true,
      response: {
        status: response.status,
        content_type: contentType || "text/plain",
        body: responseBody,
      },
    });
  } catch (error) {
    platformApiLogger.error("dynamic_variables_test_failed", {
      ...runtimePayload({ error }),
    });
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
