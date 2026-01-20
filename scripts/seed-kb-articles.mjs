#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file
config({ path: join(__dirname, "..", ".env") });

function readConfigFromEnv() {
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = Number(process.env.POSTGRES_PORT || 5432);
  const database = process.env.POSTGRES_DB || "";
  const user = process.env.POSTGRES_USER || "";
  const password = process.env.POSTGRES_PASSWORD || "";

  if (!database || !user) {
    throw new Error(
      "POSTGRES_DB and POSTGRES_USER environment variables are required"
    );
  }

  return { host, port, database, user, password };
}

async function seedKbArticles() {
  const config = readConfigFromEnv();

  console.log("[Seed KB Articles] Connecting to PostgreSQL...");
  console.log(`[Seed KB Articles] Host: ${config.host}:${config.port}`);
  console.log(`[Seed KB Articles] Database: ${config.database}`);
  console.log(`[Seed KB Articles] User: ${config.user}`);

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: false,
  });

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("[Seed KB Articles] Connected to PostgreSQL successfully");

    // Read SQL file
    const sqlPath = join(__dirname, "seed-kb-articles.sql");
    console.log(`[Seed KB Articles] Reading SQL file: ${sqlPath}`);
    let sql = readFileSync(sqlPath, "utf-8");

    // Remove commented lines (lines starting with -- that are not part of content)
    // But keep -- in the content strings
    const lines = sql.split("\n");
    const cleanedLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      // Only remove lines that are pure comments (start with -- and are not inside VALUES)
      if (trimmed.startsWith("--") && !trimmed.startsWith("-- ")) {
        // Skip comment lines, but keep content
        continue;
      }
      cleanedLines.push(line);
    }
    sql = cleanedLines.join("\n");

    // Execute the entire SQL file in a transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      console.log(`[Seed KB Articles] Executing SQL in transaction...`);

      // Execute the entire SQL file
      await client.query(sql);

      await client.query("COMMIT");
      console.log(`[Seed KB Articles] SQL executed successfully`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[Seed KB Articles] Error executing SQL:`, err.message);
      console.error(`[Seed KB Articles] Error code:`, err.code);
      throw err;
    } finally {
      client.release();
    }

    // Verify inserts
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_articles, 
        COUNT(*) FILTER (WHERE status = 'Published') as published_articles
      FROM kb_articles 
      WHERE username = 'system'
    `);

    const { total_articles, published_articles } = result.rows[0];
    console.log("\n[Seed KB Articles] ✅ Seeding completed successfully!");
    console.log(`[Seed KB Articles] Total articles: ${total_articles}`);
    console.log(`[Seed KB Articles] Published articles: ${published_articles}`);

    return true;
  } catch (error) {
    console.error("[Seed KB Articles] Error:", error.message);
    console.error(error);
    return false;
  } finally {
    await pool.end();
  }
}

async function main() {
  try {
    const success = await seedKbArticles();
    process.exit(success ? 0 : 1);
  } catch (error) {
    console.error("[Seed KB Articles] Fatal error:", error);
    process.exit(1);
  }
}

main();

