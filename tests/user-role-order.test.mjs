import assert from "node:assert/strict";
import test from "node:test";

import { sortUserRoles } from "../config/user.js";

test("user roles always follow Agent, Supervisor, Admin, Owner order", () => {
  assert.deepEqual(
    sortUserRoles(["owner", "agent", "admin", "supervisor"]),
    ["agent", "supervisor", "admin", "owner"],
  );
  assert.deepEqual(
    sortUserRoles(["ADMIN", "OWNER", "AGENT"]),
    ["AGENT", "ADMIN", "OWNER"],
  );
});
