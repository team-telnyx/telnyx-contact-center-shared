import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const repoRoot = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, repoRoot), "utf8");
}

test("Incoming Call and HTTP Request initiators expose configurable full-payload variables", async () => {
  const nodesSource = await read("config/voice-flow-nodes.js");

  const incomingBlock = nodesSource.slice(
    nodesSource.indexOf("incoming_call: {"),
    nodesSource.indexOf("http_request: {")
  );
  assert.match(incomingBlock, /payloadVariable\s*:/, "Incoming Call should define a payload variable field");
  assert.match(incomingBlock, /default:\s*"call_payload"/, "Incoming Call default payload variable should be call_payload");
  assert.match(incomingBlock, /Variable that receives the full Telnyx incoming call webhook payload/, "Incoming Call should explain the payload alias");

  const httpBlock = nodesSource.slice(
    nodesSource.indexOf("http_request: {"),
    nodesSource.indexOf("form_submit: {")
  );
  assert.match(httpBlock, /payloadVariable\s*:/, "HTTP Request should define a payload variable field");
  assert.match(httpBlock, /default:\s*"request_payload"/, "HTTP Request default payload variable should be request_payload");
  assert.match(httpBlock, /Variable that receives the full incoming HTTP request payload/, "HTTP Request should explain the payload alias");
});

test("variable utilities include Incoming Call and HTTP Request payload aliases", async () => {
  const utilsSource = await read("lib/variable-utils.js");

  assert.match(utilsSource, /nodeType === "incoming_call"[\s\S]*DEFAULT_INCOMING_CALL_PAYLOAD_VARIABLE/, "Incoming Call payload alias should be included in variable discovery");
  assert.match(utilsSource, /nodeType === "http_request"[\s\S]*DEFAULT_HTTP_REQUEST_PAYLOAD_VARIABLE/, "HTTP Request payload alias should be included in variable discovery");
  assert.match(utilsSource, /exclude\.type === "incoming_call"/, "Duplicate validation should understand Incoming Call payload aliases");
  assert.match(utilsSource, /exclude\.type === "http_request"/, "Duplicate validation should understand HTTP Request payload aliases");
});

test("Incoming Call webhook runtime binds full payload to configured alias", async () => {
  const routeSource = await read("app/api/voice/webhook/incoming/[flowId]/route.js");

  assert.match(routeSource, /DEFAULT_INCOMING_CALL_PAYLOAD_VARIABLE/, "Incoming webhook route should import/use Incoming Call payload default");
  assert.match(routeSource, /incomingPayloadVariable[\s\S]*variables\[incomingPayloadVariable\]\s*=\s*payload/, "Incoming Call runtime should bind the full Telnyx payload to the configured variable");
});

test("HTTP Request trigger route exists and binds body/query to configured alias", async () => {
  await access(new URL("app/api/voice/flows/trigger/[flowId]/route.js", repoRoot));
  const routeSource = await read("app/api/voice/flows/trigger/[flowId]/route.js");

  assert.match(routeSource, /export async function POST/, "HTTP trigger route should accept POST");
  assert.match(routeSource, /export async function GET/, "HTTP trigger route should accept GET");
  assert.match(routeSource, /DEFAULT_HTTP_REQUEST_PAYLOAD_VARIABLE/, "HTTP trigger route should use HTTP Request payload default");
  assert.match(routeSource, /variables\[payloadVariable\]\s*=\s*requestPayload/, "HTTP trigger runtime should bind request payload alias");
  assert.match(routeSource, /determineNextNodes\(flow, startNode, event, executionState\)/, "HTTP trigger route should execute downstream flow nodes");
});
