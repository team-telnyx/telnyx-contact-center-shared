import { getPostgresPool } from "@/lib/postgres.mjs";
import { readMonitorStatistics } from "@/lib/acd/monitor-statistics.mjs";
// Coalesce the three consumers of one monitor snapshot; failures never become zero counts.
let pending = null,
  key = null,
  expires = 0;
async function snapshot(options = {}) {
  const nextKey = JSON.stringify(options);
  if (pending && key === nextKey && Date.now() < expires) return pending;
  const pool = getPostgresPool();
  if (!pool) throw new Error("Statistics database unavailable");
  key = nextKey;
  expires = Date.now() + 1000;
  pending = (async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await readMonitorStatistics(db, options);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  })().catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}
export async function getQueueStatistics(queueId = null, options = {}) {
  const data = await snapshot(options);
  return queueId
    ? data.queues.find((q) => q.queueId === queueId) || null
    : data.queues;
}
export async function getAgentStatistics(userId = null, options = {}) {
  const data = await snapshot(options);
  return userId
    ? data.agents.find((a) => a.userId === userId) || null
    : data.agents;
}
export async function getOverallStatistics(options = {}) {
  return (await snapshot(options)).overall;
}
