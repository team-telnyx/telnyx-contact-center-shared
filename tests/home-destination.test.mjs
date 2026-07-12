import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ADMIN_HOME,
  SUPERVISOR_HOME,
  resolveHomeDestination,
} from "../lib/home-destination.mjs";

test("agent role always keeps My Performance as the home experience", () => {
  assert.equal(resolveHomeDestination(["agent"]), null);
  assert.equal(resolveHomeDestination(["agent", "supervisor"]), null);
  assert.equal(resolveHomeDestination(["owner", "admin", "supervisor", "agent"]), null);
});

test("supervisor without agent opens Supervisor Overview", () => {
  assert.equal(resolveHomeDestination(["supervisor"]), SUPERVISOR_HOME);
  assert.equal(resolveHomeDestination(["supervisor", "admin"]), SUPERVISOR_HOME);
  assert.equal(resolveHomeDestination(["owner", "supervisor"]), SUPERVISOR_HOME);
});

test("admin or owner without agent and supervisor opens Admin Dashboard", () => {
  assert.equal(resolveHomeDestination(["admin"]), ADMIN_HOME);
  assert.equal(resolveHomeDestination(["owner"]), ADMIN_HOME);
  assert.equal(resolveHomeDestination(["admin", "owner"]), ADMIN_HOME);
});
