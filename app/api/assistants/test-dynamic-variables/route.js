/**
 * Test Dynamic Variables Webhook
 * POST /api/assistants/test-dynamic-variables
 *
 * Tests a dynamic variables webhook with the correct payload format and authentication
 */

import { NextResponse } from "next/server";
import { platformApiLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

export async function POST(request) {
  try {
    const { url, payload } = await request.json();

    if (!url) {
      return NextResponse.json(
        { error: "Webhook URL is required" },
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
    const response = await fetch(url, {
      method: "POST",
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
