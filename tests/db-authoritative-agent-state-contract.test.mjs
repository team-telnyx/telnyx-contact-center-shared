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
const postgresSchemaPath = new URL("../lib/postgres-schema.mjs", import.meta.url);
const pgdbPath = new URL("../lib/pgdb.js", import.meta.url);
const queuedCallRouterPath = new URL(
  "../lib/contact-center/queued-call-router.js",
  import.meta.url,
);
const statsAggregatorPath = new URL(
  "../lib/contact-center/stats-aggregator.js",
  import.meta.url,
);
const routingEnginePath = new URL(
  "../lib/contact-center/routing-engine.js",
  import.meta.url,
);
const queueAgentsRoutePath = new URL(
  "../app/api/contact-center/queues/[queueId]/agents/route.js",
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

test("users legacy status columns are removed from the schema and queue lookups use cc_agent_state", async () => {
  const schemaSrc = await source(postgresSchemaPath);
  const usersTableStart = schemaSrc.indexOf("CREATE TABLE IF NOT EXISTS users");
  assert.notEqual(usersTableStart, -1, "users table schema must exist");
  const usersTableEnd = schemaSrc.indexOf(");", usersTableStart);
  assert.notEqual(usersTableEnd, -1, "users table schema block must be parseable");
  const usersTableBlock = schemaSrc.slice(usersTableStart, usersTableEnd);

  assert.doesNotMatch(
    usersTableBlock,
    /\n\s*status\s+TEXT\s+DEFAULT/i,
    "new users table schema must not create legacy users.status",
  );
  assert.doesNotMatch(
    usersTableBlock,
    /\n\s*agent_status\s+TEXT\s+DEFAULT/i,
    "new users table schema must not create legacy users.agent_status",
  );
  assert.match(
    schemaSrc,
    /DROP INDEX IF EXISTS idx_users_status[\s\S]*ALTER TABLE users DROP COLUMN status/,
    "ensurePostgresSchema must drop the legacy users.status column idempotently",
  );
  assert.match(
    schemaSrc,
    /DROP INDEX IF EXISTS idx_users_agent_status[\s\S]*ALTER TABLE users DROP COLUMN agent_status/,
    "ensurePostgresSchema must drop the legacy users.agent_status column idempotently",
  );
  assert.doesNotMatch(
    schemaSrc,
    /CREATE INDEX IF NOT EXISTS idx_users_status\b/,
    "schema must not recreate an index on the removed users.status column",
  );
  assert.doesNotMatch(
    schemaSrc,
    /CREATE INDEX IF NOT EXISTS idx_users_agent_status\b/,
    "schema must not recreate an index on the removed users.agent_status column",
  );

  const pgdbSrc = await source(pgdbPath);
  const findAgentsBlock = functionBlock(
    pgdbSrc,
    "async findAgentsInQueue",
    "async insertInteraction",
  );
  assert.match(
    findAgentsBlock,
    /JOIN\s+cc_agent_state|LEFT JOIN\s+cc_agent_state/i,
    "queue agent lookup must join cc_agent_state for status filtering",
  );
  assert.doesNotMatch(
    findAgentsBlock,
    /\bu\.status\b|\busers\.status\b/i,
    "queue agent lookup must not filter on legacy users.status",
  );
});

test("queued-call router availability uses cc_agent_state status, not stale users.agent_status", async () => {
  const routerSrc = await source(queuedCallRouterPath);
  const availabilityBlock = functionBlock(
    routerSrc,
    "async function getAgentAvailability",
    "function agentHasCapacity",
  );

  assert.match(
    availabilityBlock,
    /JOIN\s+cc_agent_state|LEFT JOIN\s+cc_agent_state/i,
    "queued-call router must join cc_agent_state for authoritative availability",
  );
  assert.match(
    availabilityBlock,
    /ast\.agent_status\s+AS\s+agent_status/i,
    "queued-call router must project cc_agent_state.agent_status as the availability status",
  );
  assert.doesNotMatch(
    availabilityBlock,
    /\bu\.agent_status\b|\busers\.agent_status\b/i,
    "queued-call router must not gate offers on stale users.agent_status",
  );
});

test("supervisor and routing availability read models use cc_agent_state status", async () => {
  const stateManagerSrc = await source(stateManagerPath);
  const stateLoadBlock = functionBlock(
    stateManagerSrc,
    "// Load agent states",
    "// Load active interactions into cache",
  );
  assert.match(stateLoadBlock, /FROM cc_agent_state ast/);
  assert.doesNotMatch(
    stateLoadBlock,
    /\bu\.agent_status\b|\busers\.agent_status\b/i,
    "state-manager DB load must not exclude/rewrite agents based on stale users.agent_status",
  );

  const statsSrc = await source(statsAggregatorPath);
  const agentStatsBlock = functionBlock(
    statsSrc,
    "export async function getAgentStatistics",
    "/**\n * Get overall contact center statistics",
  );
  assert.match(agentStatsBlock, /LEFT JOIN cc_agent_state ast[\s\S]*ast\.agent_status/);
  assert.doesNotMatch(
    agentStatsBlock,
    /\bu\.agent_status\b|\busers\.agent_status\b/i,
    "supervisor Agents stats must display cc_agent_state.agent_status, not stale users.agent_status",
  );

  const overallStatsBlock = functionBlock(
    statsSrc,
    "export async function getOverallStatistics",
    "/**\n * Aggregate statistics for a time period",
  );
  assert.match(overallStatsBlock, /LEFT JOIN cc_agent_state ast/);
  assert.match(overallStatsBlock, /ast\.agent_status/);
  assert.doesNotMatch(
    overallStatsBlock,
    /\bu\.agent_status\b|\busers\.agent_status\b/i,
    "overall stats must count Contact Center statuses from cc_agent_state",
  );

  const routingSrc = await source(routingEnginePath);
  const availableAgentsBlock = functionBlock(
    routingSrc,
    "async function getAvailableAgentsForQueue",
    "/**\n * FIFO Routing",
  );
  assert.match(availableAgentsBlock, /LEFT JOIN cc_agent_state ast/);
  assert.match(availableAgentsBlock, /ast\.agent_status AS agent_status/);
  assert.doesNotMatch(
    availableAgentsBlock,
    /\bu\.agent_status\b|\busers\.agent_status\b/i,
    "routing engine must not select/order/filter by stale users.agent_status",
  );

  const queueAgentsSrc = await source(queueAgentsRoutePath);
  assert.match(queueAgentsSrc, /LEFT JOIN cc_agent_state ast/);
  assert.match(queueAgentsSrc, /ast\.agent_status AS agent_status/);
  assert.doesNotMatch(
    queueAgentsSrc,
    /\bu\.agent_status\b|\busers\.agent_status\b/i,
    "queue agents API must not report availability from stale users.agent_status",
  );
});

test("status reporting records immutable transitions and aggregates time spent in the previous status", async () => {
  const schemaSrc = await source(postgresSchemaPath);
  assert.match(
    schemaSrc,
    /CREATE TABLE IF NOT EXISTS cc_agent_status_history[\s\S]*duration_seconds INTEGER/,
    "schema must include an immutable status history table with per-transition duration",
  );

  const userStatusSrc = await source(userStatusPath);
  assert.match(
    userStatusSrc,
    /SELECT agent_status, last_status_change[\s\S]*FROM cc_agent_state[\s\S]*FOR UPDATE/,
    "status writer must lock/read previous cc_agent_state status before overwriting it",
  );
  assert.match(
    userStatusSrc,
    /PgDb\.insertAgentStatusHistory\([\s\S]*previousStatus: effectivePreviousStatus[\s\S]*durationSeconds/,
    "status writer must persist a transition ledger row with previous status and duration",
  );
  assert.match(
    userStatusSrc,
    /activityType: "status_change"[\s\S]*activityValue: effectivePreviousStatus \|\| status[\s\S]*durationSeconds/,
    "hourly time-tracking aggregate must attribute elapsed duration to the previous status segment",
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
    /BEGIN[\s\S]*INSERT INTO cc_agent_state[\s\S]*COMMIT[\s\S]*ROLLBACK/,
    "centralized status writer must update cc_agent_state atomically in one DB transaction",
  );
  assert.doesNotMatch(
    userStatusSrc,
    /UPDATE\s+users[\s\S]*(?:status\s*=|agent_status\s*=)|SELECT[^`\n]*(?:status|agent_status)[^`\n]*FROM\s+users/i,
    "centralized status writer must not read or write legacy users.status/users.agent_status",
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
