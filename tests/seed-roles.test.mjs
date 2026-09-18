import test from "node:test";
import assert from "node:assert/strict";
import { seedRoles } from "../lib/seed-roles.mjs";
import { SYSTEM_ROLES, PRESET_ROLES } from "../lib/authz/permissions.mjs";

function mockPool({ roles = [], seeded = null } = {}) {
  const state = { roles: new Map(roles.map((r) => [r.id, r])), seeded, systemUpserts: 0, presetInserts: [] };
  async function query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    if (text.startsWith("INSERT INTO cc_roles") && text.includes("ON CONFLICT (id) DO UPDATE")) {
      state.systemUpserts += 1;
      state.roles.set(params[0], { id: params[0], name: params[1], permissions: params[3], origin: "system" });
      return { rows: [] };
    }
    if (text.startsWith("INSERT INTO cc_roles") && text.includes("ON CONFLICT (id) DO NOTHING")) {
      if (!state.roles.has(params[0])) { state.presetInserts.push(params[0]); state.roles.set(params[0], { id: params[0], name: params[1], permissions: params[3], origin: "preset" }); }
      return { rows: [] };
    }
    if (text.startsWith("SELECT cc_settings->'seeded_role_presets'")) return { rows: [{ seeded: state.seeded }] };
    if (text.startsWith("SELECT id FROM cc_roles WHERE id = ANY")) return { rows: params[0].filter((k) => state.roles.has(k)).map((id) => ({ id })) };
    if (text.startsWith("INSERT INTO app_settings")) { state.seeded = JSON.parse(params[0]); return { rows: [] }; }
    throw new Error(`Unmocked query: ${text}`);
  }
  return { connect: async () => ({ query, release() {} }), state };
}

test("a fresh database receives the system roles and all shipped presets once", async () => {
  const pool = mockPool();
  const first = await seedRoles(pool);
  assert.equal(first.systemRoles, SYSTEM_ROLES.length);
  assert.deepEqual(first.presetsInserted, PRESET_ROLES.map((r) => r.key));
  assert.deepEqual(pool.state.seeded, PRESET_ROLES.map((r) => r.key));
  const second = await seedRoles(pool);
  assert.deepEqual(second.presetsInserted, []);
  assert.equal(pool.state.systemUpserts, SYSTEM_ROLES.length * 2, "system roles are rewritten on every start");
});

test("edited presets survive and deleted presets stay deleted, while a new preset is installed", async () => {
  const seededBefore = PRESET_ROLES.map((r) => r.key).filter((k) => k !== "channel-administrator");
  const pool = mockPool({
    roles: [{ id: "team-leader", name: "Team Lead PL", permissions: ["monitor:read"], origin: "preset" }],
    seeded: seededBefore,
  });
  const result = await seedRoles(pool);
  assert.deepEqual(result.presetsInserted, ["channel-administrator"], "only the preset shipped after the last seed is installed");
  assert.equal(pool.state.roles.get("team-leader").name, "Team Lead PL", "an edited preset is not overwritten");
  assert.equal(pool.state.roles.has("quality-manager"), false, "a deleted preset does not come back");
  assert.deepEqual(pool.state.seeded, PRESET_ROLES.map((r) => r.key));
});

test("without a pool the seed is skipped without throwing", async () => {
  const result = await seedRoles(null);
  assert.equal(result.systemRoles, 0);
});
