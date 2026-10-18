#!/usr/bin/env node
import fs from "node:fs";
import dotenv from "dotenv";
const environment = {};
for (const file of [".env", ".env.local"]) if (fs.existsSync(file)) Object.assign(environment, dotenv.parse(fs.readFileSync(file)));
for (const [name, value] of Object.entries(environment)) process.env[name] ??= value;
const { getPostgresPool } = await import("../lib/postgres.mjs");
const { startVideoAiWorker } = await import("../lib/video/ai-worker.mjs");
const pool = getPostgresPool();
if (!pool) throw new Error("Video worker database is not configured");
await pool.query("SELECT video_session_id FROM cc_video_ai_sessions LIMIT 0");
const worker = await startVideoAiWorker(pool);
console.log("Video conference AI worker ready");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM", "disconnect"]) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  await worker.stop(); await pool.end();
});
