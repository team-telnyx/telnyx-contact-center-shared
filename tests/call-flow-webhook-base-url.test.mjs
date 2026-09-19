import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveWebhookBaseUrl } from "../lib/webhook-base-url.mjs";
import { rebaseFlowOwnedNodeConfig } from "../lib/voice-flow-node-rebase.mjs";

const flowRouteSource = readFile(
  new URL("../app/api/voice/flows/route.js", import.meta.url),
  "utf8",
);
const callFlowsPageSource = readFile(
  new URL("../app/(portal)/admin/call-flows/page.jsx", import.meta.url),
  "utf8",
);

test("call flow webhook prefers APP_BASE_URL over public and auth fallbacks", () => {
  const baseUrl = resolveWebhookBaseUrl({
    env: {
      NODE_ENV: "production",
      APP_BASE_URL: "https://cc.example.com/",
      NEXT_PUBLIC_BASE_URL: "https://public.example.com",
      NEXTAUTH_URL: "https://auth.example.com",
    },
  });

  assert.equal(baseUrl, "https://cc.example.com");
  assert.equal(
    `${baseUrl}/api/voice/webhook/incoming/flow-id`,
    "https://cc.example.com/api/voice/webhook/incoming/flow-id",
  );
});

test("call flow webhook supports the dedicated Telnyx override", () => {
  const baseUrl = resolveWebhookBaseUrl({
    env: {
      NODE_ENV: "production",
      TELNYX_WEBHOOK_BASE_URL: "https://voice.example.com/",
      APP_BASE_URL: "https://cc.example.com",
    },
  });

  assert.equal(baseUrl, "https://voice.example.com");
});

test("call flow webhook keeps NEXT_PUBLIC_BASE_URL as a compatibility fallback", () => {
  const baseUrl = resolveWebhookBaseUrl({
    env: {
      NODE_ENV: "production",
      NEXT_PUBLIC_BASE_URL: "https://legacy.example.com/",
    },
  });

  assert.equal(baseUrl, "https://legacy.example.com");
});

test("development can use the request origin when no base URL is configured", () => {
  const baseUrl = resolveWebhookBaseUrl({
    env: { NODE_ENV: "development" },
    requestUrl: "http://localhost:3100/api/voice/flows",
  });

  assert.equal(baseUrl, "http://localhost:3100");
});

test("production fails before registering a placeholder webhook", () => {
  assert.throws(
    () => resolveWebhookBaseUrl({ env: { NODE_ENV: "production" } }),
    /Webhook base URL is not configured/,
  );
});

test("configured webhook base URL must be an HTTP URL", () => {
  assert.throws(
    () =>
      resolveWebhookBaseUrl({
        env: { NODE_ENV: "production", APP_BASE_URL: "ftp://example.com" },
      }),
    /must use HTTP or HTTPS/,
  );
});

test("call flow creation endpoint uses the resolver and has no placeholder domain", async () => {
  const source = await flowRouteSource;

  assert.match(source, /resolveWebhookBaseUrl\(\{ requestUrl: request\.url \}\)/);
  assert.doesNotMatch(source, /your-domain\.com/);
});

test("new and duplicated call flows use the same fixed creation endpoint", async () => {
  const source = await callFlowsPageSource;
  const createHandler = source.slice(
    source.indexOf("async function handleCreate()"),
    source.indexOf("function handleDeleteClick"),
  );
  const duplicateHandler = source.slice(
    source.indexOf("async function handleDuplicate"),
    source.indexOf("async function handleExport"),
  );

  for (const handler of [createHandler, duplicateHandler]) {
    assert.match(handler, /fetch\("\/api\/voice\/flows", \{/);
    assert.match(handler, /method: "POST"/);
  }
});

test("duplicated incoming-call node receives the new flow and voice application IDs", () => {
  const sourceNode = {
    id: "incoming_call_1768932298907",
    data: {
      label: "Incoming Call",
      config: {
        webhook_url:
          "https://cc.example.com/api/voice/webhook/incoming/4d2e3dbd-73de-4ea9-a053-fa9d3022cd52",
        payloadVariable: "call_payload",
        voice_application_id: "1000000000000000000",
      },
      nodeType: "incoming_call",
    },
  };

  const [duplicatedNode] = rebaseFlowOwnedNodeConfig([sourceNode], {
    baseUrl: "https://cc.example.com",
    flowId: "d610e64c-6ff4-4ab2-bd73-0bb172327de1",
    voiceApplicationId: "1000000000000000000",
  });

  assert.equal(
    duplicatedNode.data.config.webhook_url,
    "https://cc.example.com/api/voice/webhook/incoming/d610e64c-6ff4-4ab2-bd73-0bb172327de1",
  );
  assert.equal(
    duplicatedNode.data.config.voice_application_id,
    "1000000000000000000",
  );
  assert.equal(duplicatedNode.data.config.payloadVariable, "call_payload");
  assert.equal(
    sourceNode.data.config.voice_application_id,
    "1000000000000000000",
    "source node must not be mutated",
  );
});

test("flow-owned HTTP and Dial URLs are rebased without changing external URLs", () => {
  const nodes = [
    {
      id: "http",
      data: {
        nodeType: "http_request",
        config: {
          endpoint_path:
            "https://old.example/api/voice/flows/trigger/old-flow",
        },
      },
    },
    {
      id: "dial",
      data: {
        nodeType: "dial",
        config: {
          webhook_url: "https://old.example/api/voice/webhook/flows/old-flow",
        },
      },
    },
    {
      id: "external",
      data: {
        nodeType: "data_action",
        config: { webhook_url: "https://customer.example/webhook" },
      },
    },
  ];

  const rebased = rebaseFlowOwnedNodeConfig(nodes, {
    baseUrl: "https://cc.example.com/",
    flowId: "new-flow",
    voiceApplicationId: "new-app",
  });

  assert.equal(
    rebased[0].data.config.endpoint_path,
    "https://cc.example.com/api/voice/flows/trigger/new-flow",
  );
  assert.equal(
    rebased[1].data.config.webhook_url,
    "https://cc.example.com/api/voice/webhook/flows/new-flow",
  );
  assert.equal(
    rebased[2].data.config.webhook_url,
    "https://customer.example/webhook",
  );
});

test("call flow creation persists rebased node configuration", async () => {
  const source = await flowRouteSource;

  assert.match(source, /flowData\.nodes = rebaseFlowOwnedNodeConfig/);
  assert.match(source, /voiceApplicationId: voiceApp\.id/);
  assert.ok(
    source.indexOf("flowData.nodes = rebaseFlowOwnedNodeConfig") <
      source.indexOf("VoiceFlowDb.createFlow(username, flowData)"),
  );
});
