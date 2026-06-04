import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("call answered/connected lifecycle keeps agent Busy and never resets to Available", async () => {
  const webhookSource = await source("../lib/contact-center/webhook-handler.js");

  assert.match(
    webhookSource,
    /handleAgentCallLifecycleStatus\([\s\S]*event:\s*["']connected["']/,
    "call.answered must delegate connected lifecycle status to the central handler",
  );
  assert.doesNotMatch(
    webhookSource,
    /resetAgentNotAnsweringStatus\(/,
    "answered/connected must not reset Agent Not Answering to Available",
  );
});

test("status stream is read-only presence transport and never writes routing status", async () => {
  const statusStreamSource = await source("../app/api/user/status-stream/route.js");
  const agentStreamSource = await source("../app/api/contact-center/agent/stream/route.js");

  assert.doesNotMatch(
    statusStreamSource,
    /setUserStatus\(/,
    "SSE connect/disconnect must not persist agent routing status",
  );
  assert.doesNotMatch(
    statusStreamSource,
    /status:\s*["']Offline["']/,
    "Presence disconnect must not overwrite Contact Center agent status",
  );
  assert.doesNotMatch(
    agentStreamSource,
    /setUserStatus\(/,
    "Agent SSE connect/disconnect must not persist agent routing status",
  );
  assert.doesNotMatch(
    agentStreamSource,
    /status:\s*["']Offline["']/,
    "Agent SSE disconnect must not overwrite Contact Center agent status",
  );
});

test("profile GET exposes Contact Center agent status from cc_agent_state", async () => {
  const profileSource = await source("../app/api/user/profile/route.js");

  assert.match(
    profileSource,
    /cc_agent_state[\s\S]*agent_status/,
    "Agent Desktop/header profile status must read Contact Center status from cc_agent_state",
  );
  assert.doesNotMatch(
    profileSource,
    /status:\s*user\.agent_status\s*\|\|\s*user\.status/,
    "Agent Desktop/header profile status must not read legacy users status columns",
  );
});

test("single backend call lifecycle status handler owns call-state transitions", async () => {
  const handlerSource = await source("../lib/contact-center/agent-call-lifecycle-status.js");

  assert.match(handlerSource, /export async function handleAgentCallLifecycleStatus/);
  assert.match(handlerSource, /case\s+["']ringing["'][\s\S]*markAgentBusyForRinging/);
  assert.match(handlerSource, /case\s+["']connected["'][\s\S]*markAgentBusyForRinging/);
  assert.match(handlerSource, /case\s+["']disconnected["'][\s\S]*status:\s*["']Wrapup["']/);
  assert.match(handlerSource, /case\s+["']rejected["'][\s\S]*status:\s*["']Agent Not Answering["']/);
  assert.match(handlerSource, /case\s+["']no-answer["'][\s\S]*status:\s*["']Agent Not Answering["']/);
  assert.match(handlerSource, /case\s+["']wrapup-ended["'][\s\S]*status:\s*["']Available["']/);
});

test("call lifecycle transition callers delegate to the central handler", async () => {
  const skillsSource = await source("../lib/contact-center/skills-re-evaluator.js");
  const timeoutSource = await source("../lib/contact-center/agent-answer-timeout.js");
  const reservationSource = await source("../lib/contact-center/reservation-manager.js");
  const queuedRouterSource = await source("../lib/contact-center/queued-call-router.js");
  const routeCallSource = await source("../app/api/contact-center/routing/route-call/route.js");
  const wrapupRouteSource = await source("../app/api/contact-center/interactions/[id]/wrapup/route.js");
  const wrapupSheetSource = await source("../components/contact-center/WrapupCodesSheet.jsx");

  assert.match(skillsSource, /handleAgentCallLifecycleStatus\([\s\S]*event:\s*["']ringing["']/);
  assert.doesNotMatch(skillsSource, /markAgentBusyForRinging\(/);

  assert.match(timeoutSource, /handleAgentCallLifecycleStatus\([\s\S]*event,\s*userId/);
  assert.doesNotMatch(timeoutSource, /setUserStatus\(/);
  assert.doesNotMatch(
    timeoutSource,
    /updateAgentStatus\(userId,\s*["']Available["']\)/,
    "no-answer timeout code must not auto-reset Agent Not Answering back to Available",
  );

  assert.match(reservationSource, /handleAgentCallLifecycleStatus\([\s\S]*event:\s*["']no-answer["']/);
  assert.doesNotMatch(reservationSource, /restoreAgentAvailableAfterFailedRinging\(/);

  assert.match(queuedRouterSource, /handleAgentCallLifecycleStatus\([\s\S]*event:\s*["']ringing["']/);
  assert.match(queuedRouterSource, /handleAgentCallLifecycleStatus\([\s\S]*event:\s*["']no-answer["']/);
  assert.doesNotMatch(queuedRouterSource, /markAgentBusyForRinging\(/);
  assert.doesNotMatch(queuedRouterSource, /restoreAgentAvailableAfterFailedRinging\(/);

  assert.match(routeCallSource, /handleAgentCallLifecycleStatus\([\s\S]*event:\s*["']ringing["']/);
  assert.doesNotMatch(routeCallSource, /markAgentBusyForRinging\(/);

  assert.match(wrapupRouteSource, /handleAgentCallLifecycleStatus\([\s\S]*event:\s*action\s*===\s*["']start["']\s*\?\s*["']disconnected["']\s*:\s*["']wrapup-ended["']/);
  assert.doesNotMatch(wrapupRouteSource, /setUserStatus\(/);

  assert.doesNotMatch(wrapupSheetSource, /function\s+updateAgentStatus/);
  assert.doesNotMatch(wrapupSheetSource, /fetch\(["']\/api\/user\/profile["'][\s\S]*method:\s*["']PUT["']/);
  assert.doesNotMatch(wrapupSheetSource, /updateAgentStatus\(["'](?:Wrapup|Available)["']\)/);
});

test("Contact Center agent status never depends on legacy users status columns", async () => {
  const userStatusSource = await source("../lib/contact-center/user-status.js");
  const transitionSource = await source("../lib/contact-center/agent-status-transition.js");
  const lifecycleSource = await source("../lib/contact-center/agent-call-lifecycle-status.js");
  const profileSource = await source("../app/api/user/profile/route.js");
  const agentStatusRouteSource = await source("../app/api/contact-center/agent/status/route.js");
  const routingAgentStatusSource = await source("../app/api/contact-center/routing/agent-status/route.js");
  const outboundCampaignsSource = await source("../lib/outbound-dialer/agent-campaigns.js");
  const campaignDispositionSource = await source("../app/api/contact-center/agent/campaigns/disposition/route.js");
  const authMeSource = await source("../app/api/auth/me/route.js");
  const authSigninSource = await source("../app/api/auth/signin/route.js");
  const authLogoutSource = await source("../app/api/auth/logout/route.js");
  const adminUsersSource = await source("../app/api/admin/users/route.js");
  const userActionsSource = await source("../app/actions/user.js");

  for (const [label, src] of [
    ["user-status", userStatusSource],
    ["agent-status-transition", transitionSource],
    ["agent-call-lifecycle-status", lifecycleSource],
    ["profile route", profileSource],
    ["agent status route", agentStatusRouteSource],
    ["routing agent status route", routingAgentStatusSource],
    ["outbound campaigns", outboundCampaignsSource],
    ["campaign disposition route", campaignDispositionSource],
    ["auth me route", authMeSource],
    ["auth signin route", authSigninSource],
    ["auth logout route", authLogoutSource],
    ["admin users route", adminUsersSource],
    ["user actions", userActionsSource],
  ]) {
    assert.doesNotMatch(
      src,
      /\busers\.status\b|\buser\.status\b|\btargetUser\.status\b|UPDATE\s+users\s+SET\s+status\s*=|UPDATE\s+users[\s\S]{0,160}\bagent_status\s*=|SELECT[^`\n]*(?:\bstatus\b|\bagent_status\b)[^`\n]*FROM\s+users/i,
      `${label} must not read or write legacy users.status/users.agent_status for Contact Center agent status`,
    );
    assert.doesNotMatch(
      src,
      /\busers\.agent_status\b|\buser\.agent_status\b|\btargetUser\.agent_status\b/,
      `${label} must not read legacy users.agent_status for Contact Center agent status`,
    );
  }

  assert.match(userStatusSource, /INSERT INTO cc_agent_state[\s\S]*agent_status/);
  assert.match(transitionSource, /INSERT INTO cc_agent_state[\s\S]*agent_status/);
  assert.match(profileSource, /cc_agent_state[\s\S]*agent_status/);
  assert.match(agentStatusRouteSource, /cc_agent_state[\s\S]*agent_status/);
  assert.match(routingAgentStatusSource, /cc_agent_state[\s\S]*agent_status/);
  assert.match(authMeSource, /cc_agent_state[\s\S]*agent_status/);
  assert.match(authSigninSource, /cc_agent_state[\s\S]*agent_status/);
  assert.match(adminUsersSource, /cc_agent_state[\s\S]*agent_status/);
});
