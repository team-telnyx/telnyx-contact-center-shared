import pg from "pg";
import { readDotEnvPostgres } from "./acd-test-db.mjs";
import { drainInboxOnce } from "../../lib/acd/worker.mjs";
import { sweepStalledSagas } from "../../lib/acd/saga-engine.mjs";

const [database, crashOperation = ""] = process.argv.slice(2);
if (!/^acd_core_test_[a-z0-9_]+$/.test(database || "")) throw new Error("Test database required");
globalThis.fetch = async () => { throw new Error("Network provider access prohibited in replay tests"); };
const pool = new pg.Pool({ ...readDotEnvPostgres(), database, max: 8 });
const provider = {
  name: "fixture",
  async send(command) {
    await pool.query(`INSERT INTO acd_test_provider_calls (command_id, operation)
      VALUES ($1, $2) ON CONFLICT (command_id) DO UPDATE SET deliveries = acd_test_provider_calls.deliveries + 1`,
      [command.commandId, command.operation]);
    if (command.operation === crashOperation) process.exit(86);
    return { outcome: "accepted", httpStatus: 200, response: { data: { result: "ok" } } };
  },
};
await drainInboxOnce(pool, provider, { node: `replay:${process.pid}` });
await sweepStalledSagas(pool, { provider, node: `replay:${process.pid}`, limit: 100 });
await pool.end();
