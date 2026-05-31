import { NextResponse } from "next/server";
import {
  getEntityBasePath,
  getEntitySearchPath,
} from "@/lib/data-sources-schema";

function parseDirectVariable(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^\s*\{\{([^}]+)\}\}\s*$/);
  return match?.[1]?.trim() || null;
}

function substituteVariables(value, variables = {}) {
  const directVariable = parseDirectVariable(value);
  if (directVariable && Object.prototype.hasOwnProperty.call(variables, directVariable)) {
    return variables[directVariable];
  }

  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (match, rawName) => {
      const name = rawName.trim();
      if (!Object.prototype.hasOwnProperty.call(variables, name)) return match;
      const resolved = variables[name];
      return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteVariables(item, variables));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteVariables(item, variables)])
    );
  }
  return value;
}

function getBaseUrl(request) {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    new URL(request.url).origin
  );
}

function addForwardedAuthHeaders(headers, request) {
  const aiApiKey = process.env.TELNYX_AI_API_KEY || "";
  if (aiApiKey) {
    headers[process.env.TELNYX_AI_API_KEY_REF || "telnyx-ai-api-key"] = aiApiKey;
  }

  const cookie = request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;

  const authorization = request.headers.get("authorization");
  if (authorization) headers.authorization = authorization;
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const {
      dataSource,
      action,
      fields = {},
      recordId,
      queryParams = {},
      testVariables = {},
    } = payload || {};

    if (!dataSource) {
      return NextResponse.json({ success: false, error: "Data source is required" }, { status: 400 });
    }
    if (!action) {
      return NextResponse.json({ success: false, error: "Action is required" }, { status: 400 });
    }

    const basePath = getEntityBasePath(dataSource);
    const searchPath = getEntitySearchPath(dataSource);
    if (!basePath) {
      return NextResponse.json({ success: false, error: `Unknown data source: ${dataSource}` }, { status: 400 });
    }

    const baseUrl = getBaseUrl(request);
    let url = `${baseUrl}${basePath}`;
    let method = "GET";
    let body;

    const buildBody = () => {
      const nextBody = {};
      Object.entries(fields || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          nextBody[key] = substituteVariables(value, testVariables);
        }
      });
      return JSON.stringify(nextBody);
    };

    const resolvedRecordId = substituteVariables(recordId || "", testVariables);

    switch (action) {
      case "create":
        method = "POST";
        body = buildBody();
        break;
      case "read":
        if (!resolvedRecordId) {
          return NextResponse.json({ success: false, error: "Record ID is required for read" }, { status: 400 });
        }
        method = "GET";
        url = `${url}/${encodeURIComponent(resolvedRecordId)}`;
        break;
      case "update":
        if (!resolvedRecordId) {
          return NextResponse.json({ success: false, error: "Record ID is required for update" }, { status: 400 });
        }
        method = "PATCH";
        url = `${url}/${encodeURIComponent(resolvedRecordId)}`;
        body = buildBody();
        break;
      case "delete":
        if (!resolvedRecordId) {
          return NextResponse.json({ success: false, error: "Record ID is required for delete" }, { status: 400 });
        }
        method = "DELETE";
        url = `${url}/${encodeURIComponent(resolvedRecordId)}`;
        break;
      case "list": {
        method = "GET";
        url = `${baseUrl}${searchPath}`;
        const processedQueryParams = {};
        Object.entries(queryParams || {}).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== "") {
            const resolved = substituteVariables(value, testVariables);
            processedQueryParams[key] = typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
          }
        });
        if (Object.keys(processedQueryParams).length > 0) {
          url = `${url}?${new URLSearchParams(processedQueryParams).toString()}`;
        }
        break;
      }
      default:
        return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
    }

    const headers = { "Content-Type": "application/json" };
    addForwardedAuthHeaders(headers, request);

    const response = await fetch(url, {
      method,
      headers,
      ...(body ? { body } : {}),
    });

    const responseText = await response.text();
    let responseBody;
    try {
      responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseBody = responseText;
    }

    return NextResponse.json({
      success: response.ok,
      error: response.ok ? undefined : `Data action failed: ${response.status} ${response.statusText}`,
      response: {
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
        headers: Object.fromEntries(response.headers.entries()),
        request: { url, method, body: body ? JSON.parse(body) : undefined },
      },
    });
  } catch (error) {
    console.error("[test-data-action] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to test data action" },
      { status: 500 }
    );
  }
}
