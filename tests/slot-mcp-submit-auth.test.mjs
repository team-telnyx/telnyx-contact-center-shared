import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { interactionAgentMatches } from "../lib/contact-center/interaction-agent-access.mjs";

const root = new URL("../", import.meta.url);

function hasPrivilegedRole(roles = []) {
  return roles.includes("admin") || roles.includes("owner") || roles.includes("supervisor");
}

// Exercises the REAL interactionAgentMatches against the exact composite
// condition all four routes use, not just the source-text pattern below.
function isForbidden(interaction, rawCandidates, roles) {
  const candidateUsernames = rawCandidates.filter(Boolean);
  return (
    (candidateUsernames.length === 0 || !interactionAgentMatches(interaction, candidateUsernames)) &&
    !hasPrivilegedRole(roles)
  );
}

test("the fail-closed-on-unresolved-identity composite condition behaves correctly against the real interactionAgentMatches", () => {
  // No identity resolved (e.g. an OAuth login with no users-table row),
  // interaction has an assigned agent, caller not privileged -> denied.
  assert.equal(isForbidden({ agent_username: "agent1" }, [undefined, null], []), true);
  // Same, but caller is privileged -> allowed regardless.
  assert.equal(isForbidden({ agent_username: "agent1" }, [undefined, null], ["admin"]), false);
  // Session username is stale (renamed), but the fresh by-id lookup matches -> allowed.
  assert.equal(isForbidden({ agent_username: "agent1" }, ["stale_name", "agent1"], []), false);
  // A resolved identity that genuinely isn't the assigned agent -> denied.
  assert.equal(isForbidden({ agent_username: "agent1" }, ["someone_else", null], []), true);
  // No identity resolved AND the interaction has no assigned agent either ->
  // still denied, matching the original strict comparison's behavior (an
  // unassigned interaction being open to any KNOWN agent does not extend to
  // an agent whose identity could not be established at all).
  assert.equal(isForbidden({ agent_username: null }, [undefined, null], []), true);
});

// Codex review on #1372: a strict `agent_username !== session.user.username`
// comparison false-rejects the assigned agent whenever session.user.username
// (derived from the JWT's token.email, captured at login) has drifted from
// the current users.username row — a rename or email-fallback login. The
// wrapup/metrics routes already handle this with interactionAgentMatches,
// which accepts a match against ANY known candidate identity for the caller.
//
// Codex review on #1373 (round 2): interactionAgentMatches ALSO treats an
// EMPTY candidate list as a match — intentional for the wrapup routes it was
// built for (skip the check when identity truly can't be derived), but wrong
// here: it flips these four routes from fail-closed (the old strict
// comparison denied an unresolved identity) to fail-open, letting an
// authenticated session with no users-table row (e.g. an OAuth login never
// provisioned in `users`) act on any session. Each route must deny when zero
// candidate identities resolve, before deferring to interactionAgentMatches.
function assertFailsClosedOnUnresolvedIdentity(route) {
  assert.match(route, /const candidateUsernames = \[.*\]\.filter\(Boolean\);/);
  assert.match(route, /candidateUsernames\.length === 0 \|\|/);
}

test("manual transport submit accepts any known identity for the assigned agent, but denies an unresolved one", async () => {
  const route = await readFile(
    new URL("app/api/agent-assist/workflow/mcp-submit/route.js", root),
    "utf8",
  );

  assert.match(route, /JOIN acd_history_interactions i ON i\.id = s\.work_item_id/);
  assert.match(route, /i\.agent_username/);
  assert.match(route, /import \{ interactionAgentMatches \} from "@\/lib\/contact-center\/interaction-agent-access\.mjs"/);
  assert.match(route, /SELECT username FROM users WHERE id = \$1/);
  assert.match(
    route,
    /!interactionAgentMatches\(\s*\{ agent_username: workflowSession\.agent_username \}, candidateUsernames,?\s*\)/,
  );
  assert.match(route, /!hasPrivilegedRole\(roles\)/);
  assert.match(route, /return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/);
  assert.doesNotMatch(route, /workflowSession\.agent_username !== authSession\.user\.username/);
  assertFailsClosedOnUnresolvedIdentity(route);
});

// Codex review on #1371: slot/complete/start all reached
// runAndPersistSlotMcpBindings (network egress to a configured MCP server,
// plus side effects) via nothing more than a client-supplied sessionId — no
// check that the caller is the assigned agent or privileged, unlike
// mcp-submit above. Any authenticated user could act on, and trigger MCP
// calls using, another agent's live session.
test("manual slot edit accepts any known identity for the assigned agent, but denies an unresolved one, before running MCP bindings", async () => {
  const route = await readFile(
    new URL("app/api/agent-assist/workflow/slot/[name]/route.js", root),
    "utf8",
  );

  assert.match(route, /function hasPrivilegedRole\(roles = \[\]\)/);
  assert.match(route, /import \{ interactionAgentMatches \} from "@\/lib\/contact-center\/interaction-agent-access\.mjs"/);
  assert.match(route, /SELECT agent_username FROM acd_history_interactions WHERE id = \$1/);
  assert.match(route, /SELECT username FROM users WHERE id = \$1/);
  assert.match(route, /!interactionAgentMatches\(interaction, candidateUsernames\)/);
  assert.match(route, /!hasPrivilegedRole\(roles\)/);
  assert.match(route, /return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/);
  assert.doesNotMatch(route, /interaction\?\.agent_username !== session\.user\.username/);
  assertFailsClosedOnUnresolvedIdentity(route);

  // The check must run BEFORE the MCP binding pass, not after.
  const authIdx = route.indexOf('return NextResponse.json({ error: "Forbidden" }, { status: 403 });');
  const mcpIdx = route.indexOf("await runAndPersistSlotMcpBindings(");
  assert.ok(authIdx > -1 && mcpIdx > authIdx);
});

test("manual item complete accepts any known identity for the assigned agent, but denies an unresolved one, before running MCP bindings", async () => {
  const route = await readFile(
    new URL("app/api/agent-assist/workflow/item/[id]/complete/route.js", root),
    "utf8",
  );

  assert.match(route, /function hasPrivilegedRole\(roles = \[\]\)/);
  assert.match(route, /import \{ interactionAgentMatches \} from "@\/lib\/contact-center\/interaction-agent-access\.mjs"/);
  assert.match(route, /SELECT agent_username FROM acd_history_interactions WHERE id = \$1/);
  assert.match(route, /SELECT username FROM users WHERE id = \$1/);
  assert.match(route, /!interactionAgentMatches\(interaction, candidateUsernames\)/);
  assert.match(route, /!hasPrivilegedRole\(roles\)/);
  assert.match(route, /return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/);
  assert.doesNotMatch(route, /interaction\?\.agent_username !== session\.user\.username/);
  assertFailsClosedOnUnresolvedIdentity(route);

  const authIdx = route.indexOf('return NextResponse.json({ error: "Forbidden" }, { status: 403 });');
  const mcpIdx = route.indexOf("await runAndPersistSlotMcpBindings(");
  assert.ok(authIdx > -1 && mcpIdx > authIdx);
});

// Same fail-closed identity pattern as the other four MCP-touching routes -
// this one calls out to the same MCP server (get_active_transports) using
// session data the caller doesn't otherwise control, so it needs the exact
// same "assigned agent or privileged, fail closed on unresolved identity"
// guard before ever reaching callMcpTool.
test("transport status check accepts any known identity for the assigned agent, but denies an unresolved one, before calling the MCP tool", async () => {
  const route = await readFile(
    new URL("app/api/agent-assist/workflow/transport-status/route.js", root),
    "utf8",
  );

  assert.match(route, /function hasPrivilegedRole\(roles = \[\]\)/);
  assert.match(route, /import \{ interactionAgentMatches \} from "@\/lib\/contact-center\/interaction-agent-access\.mjs"/);
  assert.match(route, /JOIN acd_history_interactions i ON i\.id = s\.work_item_id/);
  assert.match(route, /i\.agent_username/);
  assert.match(route, /SELECT username FROM users WHERE id = \$1/);
  assert.match(
    route,
    /!interactionAgentMatches\(\s*\{ agent_username: workflowSession\.agent_username \}, candidateUsernames,?\s*\)/,
  );
  assert.match(route, /!hasPrivilegedRole\(roles\)/);
  assert.match(route, /return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/);
  assert.doesNotMatch(route, /workflowSession\.agent_username !== authSession\.user\.username/);
  assertFailsClosedOnUnresolvedIdentity(route);

  const authIdx = route.indexOf('return NextResponse.json({ error: "Forbidden" }, { status: 403 });');
  const mcpIdx = route.indexOf("await callMcpTool(");
  assert.ok(authIdx > -1 && mcpIdx > authIdx);

  // The response returned to the requesting agent may carry real trip data
  // (the agent is already authorized to see their own submitted trip), but
  // the diagnostic LOG must stay shape-only - same policy as mcp-submit's
  // create_transport logging (Codex review on PR #1393, P1).
  assert.match(route, /import \{ agentAssistRuntimePayload, describeShape, workflowLogger \} from "@\/lib\/agent-assist\/logging\.mjs";/);
  const shapeLogIdx = route.indexOf('workflowLogger.info("transport_status_check_result_shape"');
  const shapeLogEnd = route.indexOf("}));", shapeLogIdx);
  assert.ok(shapeLogIdx > -1 && shapeLogEnd > shapeLogIdx, "expected the shape-only diagnostic log call");
  const shapeLogCall = route.slice(shapeLogIdx, shapeLogEnd);
  assert.match(shapeLogCall, /resultShape: JSON\.stringify\(describeShape\(match \|\| list\[0\] \|\| null\)\)/);
  // The log call's own fields must never include the raw matched entry or
  // list as a value (only the shape-derived string above) - "matchFound:
  // !!match," is fine, "trip: match," or "entry: list," would not be.
  assert.doesNotMatch(shapeLogCall, /:\s*match,|:\s*list,/);
});

// Codex review (PR #1396, P1): aa_workflow_items has no workflow_id column
// (only stage_id, per lib/postgres-schema.mjs) - a bare "WHERE workflow_id
// = $1" against it raises an undefined-column error on every single
// request, exactly the join-through-stages pattern already used everywhere
// else in this codebase for workflow-item queries.
test("transport status check joins through aa_workflow_stages instead of querying a non-existent workflow_id column on aa_workflow_items", async () => {
  const route = await readFile(
    new URL("app/api/agent-assist/workflow/transport-status/route.js", root),
    "utf8",
  );
  assert.match(
    route,
    /FROM aa_workflow_items i\s*\n\s*JOIN aa_workflow_stages s ON s\.id = i\.stage_id\s*\n\s*WHERE s\.workflow_id = \$1/,
  );
  assert.doesNotMatch(route, /FROM aa_workflow_items\s*\n\s*WHERE workflow_id = \$1/);
});

// Codex review (PR #1396, P1): matching by "does the trip id appear
// anywhere in the serialized entry" is a substring check, not an identity
// check - a trip id that happens to be a substring of another value (or of
// a different trip's id, e.g. numeric "123" vs "1234") would return a
// DIFFERENT transport's patient/location data to an agent authorized only
// for their own session.
test("findTripInList requires an exact value match, not a substring of the whole serialized entry", () => {
  function findTripInList(list, tripId) {
    const needle = String(tripId);
    const hasExactMatch = (value, depth = 0) => {
      if (depth > 6) return false;
      if (value === null || value === undefined) return false;
      if (typeof value === "string" || typeof value === "number") return String(value) === needle;
      if (Array.isArray(value)) return value.some((entry) => hasExactMatch(entry, depth + 1));
      if (typeof value === "object") return Object.values(value).some((entry) => hasExactMatch(entry, depth + 1));
      return false;
    };
    return list.find((entry) => hasExactMatch(entry)) || null;
  }

  const list = [
    { tripId: "1234", patient: "Unrelated Patient" },
    { tripId: "123", patient: "Our Patient" },
  ];
  // "123" must match ONLY its own exact entry, never the "1234" entry it's
  // a substring of.
  assert.deepEqual(findTripInList(list, "123"), { tripId: "123", patient: "Our Patient" });
  assert.equal(findTripInList(list, "999"), null);
  // Nested trip id (e.g. inside a tripLeg array) is still found.
  const nested = [{ trip: { legs: [{ id: "abc-123" }] }, patient: "Our Patient" }];
  assert.equal(findTripInList(nested, "abc-123")?.patient, "Our Patient");
});

// Codex review (PR #1396, P2): hardcoding "transport_olos_trip_id"/
// "contract_id_numeric" only works for THIS workflow's own naming choice.
// The route must derive the trip-id slot from create_transport's own
// `outputs` mapping, and the contract-id slot from whichever slot a
// sibling binding (lookup_addresses, etc.) already references for the
// same "contractId" argument the reference workflow tools share - not a literal guess.
test("transport status check derives trip-id and contract-id slot names from the workflow's own bindings, not hardcoded literals", async () => {
  const route = await readFile(
    new URL("app/api/agent-assist/workflow/transport-status/route.js", root),
    "utf8",
  );
  assert.match(route, /function findOutputSlotName\(binding, resultPath\)/);
  assert.match(route, /function findSlotRefForArgument\(bindings, argKey\)/);
  assert.match(
    route,
    /const tripIdSlotName = findOutputSlotName\(submitBinding, "olos_trip_id"\) \|\| "olos_trip_id";/,
  );
  assert.match(
    route,
    /const contractSlotName = findSlotRefForArgument\(workflowBindings, "contractId"\) \|\| "contract_id_numeric";/,
  );
  assert.doesNotMatch(route, /slotsFilled\.transport_olos_trip_id/);
  assert.doesNotMatch(route, /slotsFilled\.contract_id_numeric/);
});

test("workflow start accepts any known identity for the assigned agent, but denies an unresolved one, before running the startup MCP pass", async () => {
  const route = await readFile(
    new URL("app/api/agent-assist/workflow/start/route.js", root),
    "utf8",
  );

  assert.match(route, /function hasPrivilegedRole\(roles = \[\]\)/);
  assert.match(route, /import \{ interactionAgentMatches \} from "@\/lib\/contact-center\/interaction-agent-access\.mjs"/);
  assert.match(route, /findWorkItemByReference\(pool, interactionId\)/);
  assert.match(route, /SELECT username FROM users WHERE id = \$1/);
  assert.match(route, /!interactionAgentMatches\(interaction, candidateUsernames\)/);
  assert.match(route, /!hasPrivilegedRole\(roles\)/);
  assert.match(route, /return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/);
  assert.doesNotMatch(route, /interaction\.agent_username !== session\.user\.username/);
  assertFailsClosedOnUnresolvedIdentity(route);

  const authIdx = route.indexOf('return NextResponse.json({ error: "Forbidden" }, { status: 403 });');
  const mcpIdx = route.indexOf("await runAndPersistSlotMcpBindings(");
  assert.ok(authIdx > -1 && mcpIdx > authIdx);
});
