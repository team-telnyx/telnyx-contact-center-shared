import { setTimeout as delay } from "node:timers/promises";
import { allowsWorkerRole, getProcessRole } from "./process-role.mjs";

export function shouldStartVideoAiService(env = process.env) {
  return allowsWorkerRole(getProcessRole(env.PROCESS_ROLE || "all"))
    && env.VIDEO_AI_EXTERNAL_WORKER !== "true"
    && env.VIDEO_CONFERENCE_AI_ENABLED !== "false";
}

// Owned by the application launcher, outside Next's compiler/HMR processes.
// No separate Video AI Node process or production opt-in is needed.
export function startVideoAiService({
  env = process.env,
  retryMs = 5000,
  getPool = async () => (await import("../postgres.mjs")).getPostgresPool(),
  startWorker = async (pool, options) => (await import("../video/ai-worker.mjs")).startVideoAiWorker(pool, options),
  onError = () => {},
  onState = () => {},
} = {}) {
  const abort = new AbortController();
  let worker, stopPromise;
  const state = { status: shouldStartVideoAiService(env) ? "starting" : "disabled", owner: null };
  const update = (status, owner = null) => { Object.assign(state, { status, owner }); onState({ ...state }); };
  if (state.status === "disabled") update("disabled");
  const done = state.status === "disabled" ? Promise.resolve() : (async () => {
    while (!abort.signal.aborted) {
      try {
        update("starting");
        const pool = await getPool();
        if (!pool) throw new Error("Video AI database is not configured");
        // The normal application bootstrap owns schema initialization. Retry
        // while it is starting, without creating a competing migration path.
        await pool.query("SELECT video_session_id FROM cc_video_ai_sessions LIMIT 0");
        if (abort.signal.aborted) break;
        let fail;
        const failure = new Promise(resolve => { fail = resolve; });
        worker = await startWorker(pool, { onFailure: fail });
        if (abort.signal.aborted) break;
        update("ready", worker.owner);
        const stopped = () => fail(null);
        abort.signal.addEventListener("abort", stopped, { once: true });
        const error = await failure;
        abort.signal.removeEventListener("abort", stopped);
        if (error) throw error;
      } catch (error) {
        if (!abort.signal.aborted) { update("retrying"); onError(error); }
      } finally {
        const current = worker; worker = null;
        await current?.stop().catch(onError);
      }
      if (!abort.signal.aborted) await delay(retryMs, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();
  return {
    state,
    stop() {
      return stopPromise ||= (async () => { abort.abort(); await done; update("stopped"); })();
    },
  };
}
