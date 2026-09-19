/**
 * Seed roles (the internal documentation, decision D-19).
 *
 * System roles (agent, supervisor, admin, owner) are defined by the product:
 * their permissions are rewritten from the catalogue on every start.
 *
 * Shipped position roles are inserted once. The keys that were ever seeded
 * are remembered in app_settings.cc_settings.seeded_role_presets, so an
 * administrator's edits survive upgrades and a deleted preset stays deleted.
 * A preset added in a later release is installed on upgrade.
 */
import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { getPostgresPool } from "./postgres.mjs";
import { SYSTEM_ROLES, PRESET_ROLES } from "./authz/permissions.mjs";

const seedLogger = createDiagnosticLogger("platform.app");

export async function seedRoles(pool = getPostgresPool()) {
  if (!pool) {
    seedLogger.warn("seed_roles_db_unavailable");
    return { systemRoles: 0, presetsInserted: [], presetsSkipped: [] };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const role of SYSTEM_ROLES) {
      await client.query(
        `INSERT INTO cc_roles (id, name, description, is_system, origin, permissions, scopes, created_at, updated_at)
         VALUES ($1, $2, $3, true, 'system', $4, $5::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, is_system = true, origin = 'system',
           permissions = EXCLUDED.permissions, scopes = EXCLUDED.scopes, updated_at = NOW()`,
        [role.key, role.name, role.description, role.permissions, JSON.stringify(role.scopes)],
      );
    }

    const settings = await client.query(`SELECT cc_settings->'seeded_role_presets' AS seeded FROM app_settings WHERE id = 'default'`);
    const seeded = new Set(Array.isArray(settings.rows?.[0]?.seeded) ? settings.rows[0].seeded.map(String) : []);
    const existing = await client.query(`SELECT id FROM cc_roles WHERE id = ANY($1::text[])`, [PRESET_ROLES.map((r) => r.key)]);
    const present = new Set((existing.rows || []).map((row) => row.id));

    const inserted = [];
    const skipped = [];
    for (const preset of PRESET_ROLES) {
      if (seeded.has(preset.key) || present.has(preset.key)) { skipped.push(preset.key); continue; }
      await client.query(
        `INSERT INTO cc_roles (id, name, description, is_system, origin, permissions, scopes, created_at, updated_at)
         VALUES ($1, $2, $3, false, 'preset', $4, $5::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [preset.key, preset.name, preset.description, preset.permissions, JSON.stringify(preset.scopes)],
      );
      inserted.push(preset.key);
    }

    const remembered = [...new Set([...seeded, ...PRESET_ROLES.map((r) => r.key)])];
    await client.query(
      `INSERT INTO app_settings (id, cc_settings) VALUES ('default', jsonb_build_object('seeded_role_presets', $1::jsonb))
       ON CONFLICT (id) DO UPDATE SET cc_settings = jsonb_set(COALESCE(app_settings.cc_settings, '{}'::jsonb), '{seeded_role_presets}', $1::jsonb)`,
      [JSON.stringify(remembered)],
    );
    await client.query("COMMIT");
    seedLogger.info("seed_roles_ok", { systemRoles: SYSTEM_ROLES.length, presetsInserted: inserted, presetsSkipped: skipped });
    return { systemRoles: SYSTEM_ROLES.length, presetsInserted: inserted, presetsSkipped: skipped };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    seedLogger.error("seed_roles_failed", { error: err?.message || String(err) });
    throw err;
  } finally {
    client.release();
  }
}
