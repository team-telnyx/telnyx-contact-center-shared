import { spawn } from "node:child_process";
import { resolve } from "node:path";

export function shouldStartLocalVideoAiService(env = process.env) {
  return (env.NODE_ENV === "development" || env.VIDEO_AI_LOCAL_WORKER === "true")
    && env.VIDEO_AI_EXTERNAL_WORKER !== "true" && env.VIDEO_CONFERENCE_AI_ENABLED !== "false";
}

// next dev includes the media service. A local production build can opt in;
// deployed production keeps its dedicated worker unless explicitly configured.
export function startLocalVideoAiService({ onError = () => {} } = {}) {
  if (!shouldStartLocalVideoAiService()) return;
  if (globalThis.__ccDevelopmentVideoAi) return;
  let child, timer, stopping = false;
  const launch = () => {
    if (stopping) return;
    child = spawn(process.execPath, [resolve(process.cwd(), "scripts/video-ai-worker.mjs")], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: process.env });
    child.on("error", error => onError(error));
    child.once("exit", code => { if (!stopping) { onError(new Error(`Video AI service exited (${code}); restarting`)); timer = setTimeout(launch, 5000); timer.unref(); } });
  };
  const stop = () => { stopping = true; clearTimeout(timer); if (child?.connected) child.disconnect(); };
  globalThis.__ccDevelopmentVideoAi = { stop };
  process.once("exit", stop);
  launch();
}
