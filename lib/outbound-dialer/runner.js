import { runnerLogger, outboundErrorPayload } from "./logging.mjs";
// Compatibility entry points for the execution UI. The ACD worker discovers
// running campaigns from PostgreSQL on every node; no web-process timers.
export function startAgentlessRunner({ pool }) {
  pool?.query(`SELECT pg_notify('acd_events', '{}')`).catch(error => runnerLogger.error("durable_worker_wakeup_failed", outboundErrorPayload(error)));
}
export function stopAgentlessRunner() { /* persisted campaign status stops admission */ }
export function getRunnerState() { return { durable: true, managedBy: 'acd_core' }; }
