#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getPostgresPool } from "../lib/postgres.mjs";
import { ensurePostgresSchema } from "../lib/postgres-schema.mjs";
import { seedFormBuilderSamples } from "../lib/forms/form-builder-seeds.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadDotEnv(file = path.join(repoRoot, ".env")) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function hasArg(name) {
  return process.argv.includes(name);
}

function assertDevSafe(dbInfo) {
  const envName = String(process.env.NODE_ENV || process.env.APP_ENV || process.env.VERCEL_ENV || "development").toLowerCase();
  const databaseUrl = String(process.env.DATABASE_URL || process.env.POSTGRES_URL || "").toLowerCase();
  const databaseName = String(dbInfo?.database || process.env.POSTGRES_DB || "").toLowerCase();
  const host = String(dbInfo?.host || process.env.POSTGRES_HOST || "").toLowerCase();
  const looksProd = envName === "production" || databaseUrl.includes("prod") || databaseName.includes("prod") || host.includes("prod");
  if (looksProd) throw new Error(`Refusing destructive template reset against production-looking database/env (env=${envName}, db=${databaseName || "unknown"}, host=${host || "unknown"}).`);
}

async function main() {
  loadDotEnv();
  const resetTemplates = hasArg("--reset-templates");
  await ensurePostgresSchema();
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres pool not available");
  const client = await pool.connect();
  try {
    const { rows: [info] } = await client.query("SELECT current_database() AS database, inet_server_addr()::text AS host");
    if (resetTemplates) assertDevSafe(info);
    const before = await client.query("SELECT COUNT(*)::int AS count FROM form_templates");
    const result = await seedFormBuilderSamples(client, { reset: resetTemplates });
    const afterTemplates = await client.query("SELECT COUNT(*)::int AS count FROM form_templates");
    const afterMedia = await client.query("SELECT COUNT(*)::int AS count FROM form_media_assets WHERE metadata->>'formTemplateSeed' = 'true' OR metadata->>'seed' = 'true'");
    const afterFlows = await client.query("SELECT COUNT(*)::int AS count FROM voice_flows WHERE metadata->>'formBuilderSeed' = 'true' OR metadata->>'seed' = 'true'");
    console.log(JSON.stringify({ ok: true, resetTemplates, database: info, before: { templates: before.rows[0].count }, seed: result, after: { templates: afterTemplates.rows[0].count, seededMedia: afterMedia.rows[0].count, seededFlows: afterFlows.rows[0].count } }, null, 2));
  } finally {
    client.release();
    await pool.end?.();
  }
}

main().catch((error) => {
  console.error(`[Seed Form Builder Samples] ${error.message}`);
  process.exit(1);
});
