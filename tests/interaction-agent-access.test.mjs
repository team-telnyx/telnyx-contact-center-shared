import test from "node:test";
import assert from "node:assert/strict";
import { interactionAgentMatches } from "../lib/contact-center/interaction-agent-access.mjs";

test("unassigned interaction (no agent_username) is accessible to any agent", () => {
  assert.equal(interactionAgentMatches({ agent_username: null }, ["alice"]), true);
  assert.equal(interactionAgentMatches({}, ["alice"]), true);
  assert.equal(interactionAgentMatches({ agent_username: "" }, []), true);
  assert.equal(interactionAgentMatches(null, ["alice"]), true);
});

test("matches when any candidate username equals the interaction's agent", () => {
  assert.equal(interactionAgentMatches({ agent_username: "alice" }, ["alice"]), true);
  // Divergent sources: session username differs from id-derived, but one matches.
  assert.equal(interactionAgentMatches({ agent_username: "alice" }, ["alice.smith", "alice"]), true);
  assert.equal(interactionAgentMatches({ agent_username: "alice" }, [null, "alice"]), true);
});

test("rejects a genuinely different agent (matches no candidate)", () => {
  assert.equal(interactionAgentMatches({ agent_username: "bob" }, ["alice"]), false);
  assert.equal(interactionAgentMatches({ agent_username: "bob" }, ["alice", "alice.smith"]), false);
});

test("does not block when the current user's identity could not be derived", () => {
  // No candidates (both sources null/empty) → don't reject (matches prior
  // behavior of skipping the check when username was falsy).
  assert.equal(interactionAgentMatches({ agent_username: "bob" }, []), true);
  assert.equal(interactionAgentMatches({ agent_username: "bob" }, [null, undefined, ""]), true);
});

test("accepts a single string (not just an array) of candidates", () => {
  assert.equal(interactionAgentMatches({ agent_username: "alice" }, "alice"), true);
  assert.equal(interactionAgentMatches({ agent_username: "alice" }, "bob"), false);
});
