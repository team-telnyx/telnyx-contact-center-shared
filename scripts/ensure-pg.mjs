#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Pool } from "pg";
import { ensurePostgresSchema } from "../lib/postgres-schema.mjs";
import { readPostgresSslConfig } from "../lib/postgres-ssl.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file
config({ path: join(__dirname, "..", ".env") });

function readConfigFromEnv() {
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = Number(process.env.POSTGRES_PORT || 5432);
  const database = process.env.POSTGRES_DB || "";
  const user = process.env.POSTGRES_USER || "postgres";
  const password = process.env.POSTGRES_PASSWORD || "";
  return { host, port, database, user, password };
}

async function databaseExists(pool, dbName) {
  try {
    const result = await pool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName]
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error(
      "[Ensure PG] Error checking database existence:",
      err.message
    );
    return false;
  }
}

async function createDatabase(config) {
  // Connect to default 'postgres' database to create the target database
  const adminPool = new Pool({
    host: config.host,
    port: config.port,
    database: "postgres", // Connect to default postgres database
    user: config.user,
    password: config.password,
    ssl: readPostgresSslConfig(),
  });

  try {
    console.log(
      `[Ensure PG] Checking if database '${config.database}' exists...`
    );
    const exists = await databaseExists(adminPool, config.database);

    if (exists) {
      console.log(`[Ensure PG] Database '${config.database}' already exists`);
      return true;
    }

    console.log(`[Ensure PG] Creating database '${config.database}'...`);
    // Escape database name to prevent SQL injection
    const escapedDbName = `"${config.database.replace(/"/g, '""')}"`;
    await adminPool.query(`CREATE DATABASE ${escapedDbName}`);
    console.log(
      `[Ensure PG] Database '${config.database}' created successfully`
    );
    return true;
  } catch (err) {
    if (err.code === "42P04") {
      // Database already exists (race condition)
      console.log(`[Ensure PG] Database '${config.database}' already exists`);
      return true;
    }
    console.error(`[Ensure PG] Failed to create database:`, err.message);
    return false;
  } finally {
    await adminPool.end();
  }
}

async function main() {
  const config = readConfigFromEnv();

  if (!config.database) {
    console.error("[Ensure PG] POSTGRES_DB environment variable is not set");
    process.exit(1);
  }

  console.log("[Ensure PG] Ensuring PostgreSQL database and schema...");

  // First, ensure the database exists
  const dbCreated = await createDatabase(config);
  if (!dbCreated) {
    console.error("[Ensure PG] Failed to ensure database exists");
    process.exit(1);
  }

  // Then, ensure the schema
  const success = await ensurePostgresSchema();
  if (success) {
    console.log("[Ensure PG] Database and schema ensured successfully");
    process.exit(0);
  } else {
    console.error("[Ensure PG] Failed to ensure schema");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[Ensure PG] Error:", err);
  process.exit(1);
});
