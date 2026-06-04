import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const stateManagerPath = new URL(
  "../lib/contact-center/state-manager.js",
  import.meta.url,
);
const userStatusPath = new URL(
  "../lib/contact-center/user-status.js",
  import.meta.url,
);
const profileRoutePath = new URL(
  "../app/api/user/profile/route.js",
  import.meta.url,
);
const routingAgentStatusRoutePath = new URL(
  "../app/api/contact-center/routing/agent-status/route.js",
  import.meta.url,
);
const agentAnswerTimeoutPath = new URL(
  "../lib/contact-center/agent-answer-timeout.js",
  import.meta.url,
);
const outboundCampaignsPath = new URL(
  "../lib/outbound-dialer/agent-campaigns.js",
  import.meta.url,
);
const campaignDispositionRoutePath = new URL(
  "../app/api/contact-center/agent/campaigns/disposition/route.js",
  import.meta.url,
);
const agentDesktopPath = new URL(
  "../components/contact-center/AgentDesktop.jsx",
  import.meta.url,
);
const softphonePath = new URL("../components/softphone.jsx", import.meta.url);
const softphoneMiniPath = new URL("../components/softphone-mini.jsx", import.meta.url);
const navUserPath = new URL("../components/nav-user.jsx", import.meta.url);
const authProviderPath = new URL("../components/auth-provider.jsx", import.meta.url);
const wrapupSheetPath = new URL(
  "../components/contact-center/WrapupCodesSheet.jsx",
  import.meta.url,
);

async function source(path) {
  return readFile(path, "utf8");
}

function functionBlock(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing start needle: ${startNeedle}`);
  const end = endNeedle ? src.indexOf(endNeedle, start + startNeedle.length) : src.length;
  assert.notEqual(end, -1, `missing end needle: ${endNeedle}`);
  return src.slice(start, end);
}

test("state-manager is not a DB writer for agent status in HA mode", async () => {
  const src = await source(stateManagerPath);
  const syncBlock = functionBlock(
    src,
    "async function syncStateToDatabase()",
    "/**\n * Update queue state when a call is enqueued",
  );

  assert.doesNotMatch(
    syncBlock,
    /INSERT INTO cc_agent_state[\s\S]*agent_status\s*=\s*EXCLUDED\.agent_status/,
    "periodic in-memory sync must not upsert cc_agent_state.agent_status from a node-local cache",
  );
  assert.doesNotMatch(
    syncBlock,
    /agentState\.agentStatus/,
    "periodic sync must not read cached agentStatus for DB persistence",
  );
});

test("state-manager call lifecycle helpers do not mutate cached agentStatus as source of truth", async () => {
  const src = await source(stateManagerPath);
  for (const [startNeedle, endNeedle] of [
    ["export function assignCallToAgent", "/**\n * Remove call assignment"],
    ["export function removeCallFromAgent", "/**\n * Update state when a call is answered"],
    ["export function completeCall", "/**\n * Update agent status"],
  ]) {
    const block = functionBlock(src, startNeedle, endNeedle);
    assert.doesNotMatch(
      block,
      /agentState\.agentStatus\s*=/,
      `${startNeedle} must not assign lifecycle status in node-local stateCache`,
    );
  }

  const updateStatusBlock = functionBlock(
    src,
    "export async function updateAgentStatus",
    "/**\n * Update agent queue activation",
  );
  assert.match(
    updateStatusBlock,
    /agentState\.agentStatus\s*=\s*status/,
    "explicit DB-authoritative status updates must refresh the node-local read model",
  );
  assert.doesNotMatch(
    updateStatusBlock,
    /UPDATE\s+cc_agent_state|INSERT INTO cc_agent_state|UPDATE\s+users/i,
    "read-model status refresh must not write status back to DB",
  );
});

test("all server-side Contact Center status transitions go through the centralized DB status writer", async () => {
  const userStatusSrc = await source(userStatusPath);
  assert.match(
    userStatusSrc,
    /export async function setUserStatus\(/,
    "centralized Contact Center status writer must be exported",
  );
  assert.match(
    userStatusSrc,
    /BEGIN[\s\S]*UPDATE users[\s\S]*INSERT INTO cc_agent_state[\s\S]*COMMIT[\s\S]*ROLLBACK/,
    "centralized status writer must update users and cc_agent_state atomically in one DB transaction",
  );

  const files = [
    profileRoutePath,
    routingAgentStatusRoutePath,
    agentAnswerTimeoutPath,
    outboundCampaignsPath,
    campaignDispositionRoutePath,
  ];
  for (const file of files) {
    const src = await source(file);
    assert.doesNotMatch(
      src,
      /UPDATE users SET agent_status|UPDATE users\s+SET[\s\S]{0,120}agent_status|INSERT INTO cc_agent_state[\s\S]{0,220}agent_status|UPDATE cc_agent_state[\s\S]{0,160}agent_status/,
      `${file.pathname} must not write Contact Center agent status directly; use setUserStatus()/DB lifecycle helpers`,
    );
  }
});

test("frontend does not persist user.status in localStorage or derive lifecycle writes from it", async () => {
  const files = [
    agentDesktopPath,
    softphonePath,
    softphoneMiniPath,
    navUserPath,
    authProviderPath,
    wrapupSheetPath,
  ];
  for (const file of files) {
    const src = await source(file);
    assert.doesNotMatch(
      src,
      /localStorage\.(?:setItem|getItem)\(\s*["']user\.status["']/,
      `${file.pathname} must not use localStorage('user.status') as Contact Center status state`,
    );
  }

  for (const file of [softphonePath, softphoneMiniPath]) {
    const src = await source(file);
    assert.doesNotMatch(
      src,
      /fetch\(\s*["']\/api\/user\/profile["'][\s\S]{0,260}status:\s*nextStatus/,
      `${file.pathname} must not auto-write agent lifecycle status from call-derived UI state`,
    );
    assert.doesNotMatch(
      src,
      /Auto-set agent status based on call activity|forcedBusy|updateUserStatus\(/,
      `${file.pathname} must not contain frontend call-activity status automation`,
    );
  }
});
