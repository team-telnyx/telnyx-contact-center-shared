import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const stateManagerPath = new URL("../lib/contact-center/state-manager.js", import.meta.url);
const webhookHandlerPath = new URL("../lib/contact-center/webhook-handler.js", import.meta.url);
const wrapupRoutePath = new URL("../app/api/contact-center/interactions/[id]/wrapup/route.js", import.meta.url);

async function readSource(url) {
  return readFile(url, "utf8");
}

function extractFunction(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} should exist`);
  const signatureEnd = source.indexOf(")", start);
  const bodyStart = source.indexOf("{", signatureEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

test("completeCall no longer exposes Available or locally sets Wrapup in DB-authoritative mode", async () => {
  const source = await readSource(stateManagerPath);
  const completeCall = extractFunction(source, "completeCall");

  assert.doesNotMatch(
    completeCall,
    /agentState\.agentStatus\s*=/,
    "completeCall should not be a lifecycle status writer; server-side Wrapup is written before this read-model mutation",
  );
  assert.doesNotMatch(
    completeCall,
    /"Available"|"Wrapup"/,
    "completeCall must not expose Available or locally force Wrapup",
  );
});

test("webhook hangup starts server-side Wrapup before completing the in-memory call", async () => {
  const source = await readSource(webhookHandlerPath);

  assert.match(
    source,
    /async function startServerSideWrapupForInteraction/,
    "webhook handler should have a single server-side Wrapup primitive",
  );
  assert.match(
    source,
    /setUserStatus\(\{[\s\S]*status:\s*"Wrapup"/,
    "server-side Wrapup should update the authoritative agent status tables",
  );

  const directHangupPath = extractFunction(source, "handleCallEnded");
  assert.ok(
    directHangupPath.indexOf("await startServerSideWrapupForInteraction") !== -1,
    "direct call-ended handler should start Wrapup after DB completion update",
  );
  assert.ok(
    directHangupPath.indexOf("await startServerSideWrapupForInteraction") <
      directHangupPath.indexOf("completeCall"),
    "Wrapup status must be written before completeCall mutates in-memory availability",
  );
});

test("wrapup route ends server-authoritative Wrapup by returning the agent to Available", async () => {
  const source = await readSource(wrapupRoutePath);
  const routeBody = extractFunction(source, "POST");

  assert.match(routeBody, /setUserStatus\(/, "wrapup route should update authoritative status");
  assert.match(
    routeBody,
    /status:\s*"Available"/,
    "wrapup end should explicitly transition the agent back to Available",
  );
});
