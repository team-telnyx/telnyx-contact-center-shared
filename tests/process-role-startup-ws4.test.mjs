import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("WS4-T4 process role helper defaults to single-node all and exposes role gates", async () => {
  const roleSource = await source("lib/runtime/process-role.mjs");

  assert.match(roleSource, /process\.env\.PROCESS_ROLE\s*\|\|\s*["']all["']/);
  assert.match(roleSource, /ROLE_ALL\s*=\s*["']all["']/);
  assert.match(roleSource, /ROLE_WEB\s*=\s*["']web["']/);
  assert.match(roleSource, /ROLE_WORKER\s*=\s*["']worker["']/);
  assert.match(roleSource, /ROLE_STREAMING\s*=\s*["']streaming["']/);
  assert.match(roleSource, /export function allowsWebRole/);
  assert.match(roleSource, /export function allowsWorkerRole/);
  assert.match(roleSource, /export function allowsStreamingRole/);
  assert.match(roleSource, /export function allowsMaintenanceRole/);

  const previous = process.env.PROCESS_ROLE;
  try {
    delete process.env.PROCESS_ROLE;
    const role = await import(`../lib/runtime/process-role.mjs?test=${Date.now()}`);
    assert.equal(role.getProcessRole(), "all");
    assert.equal(role.allowsWebRole(), true);
    assert.equal(role.allowsWorkerRole(), true);
    assert.equal(role.allowsStreamingRole(), true);
    assert.equal(role.allowsMaintenanceRole(), true);
  } finally {
    if (previous === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = previous;
  }
});

test("WS4-T4 instrumentation uses PROCESS_ROLE gates for schema/cleanup, streaming, and coordinator startup", async () => {
  const instrumentation = await source("instrumentation.js");

  assert.match(instrumentation, /from "\.\/lib\/runtime\/process-role\.mjs"/);
  assert.match(instrumentation, /const processRole = getProcessRole\(\)/);
  assert.match(instrumentation, /allowsMaintenanceRole\(processRole\)/);
  assert.match(instrumentation, /allowsStreamingRole\(processRole\)/);
  assert.match(instrumentation, /allowsWorkerRole\(processRole\)/);
  assert.match(instrumentation, /processRole/);
  assert.match(instrumentation, /startCoordinator\(\)/);
  assert.match(instrumentation, /streaming_ws_skipped_for_process_role/);
  assert.doesNotMatch(
    instrumentation,
    /initStreamingWSServer\(\);\n\s*streamingLogger\.info\("streaming_ws_start_requested"/,
    "streaming WS must not start unconditionally in every Next process",
  );
});

test("WS4-T4 production start wrapper can run web, worker, or streaming-only roles from the same image", async () => {
  const startWrapper = await source("scripts/start-next-with-pino.mjs");
  const dockerfile = await source("docker/production/Dockerfile");

  assert.match(startWrapper, /from "\.\.\/lib\/runtime\/process-role\.mjs"/);
  assert.match(startWrapper, /const processRole = getProcessRole\(\)/);
  assert.match(startWrapper, /allowsWebRole\(processRole\)/);
  assert.match(startWrapper, /allowsStreamingRole\(processRole\)/);
  assert.match(startWrapper, /allowsWorkerRole\(processRole\)/);
  assert.match(startWrapper, /startStreamingOnlyRuntime/);
  assert.match(startWrapper, /startWorkerOnlyRuntime/);
  assert.match(startWrapper, /process_role_runtime_starting/);
  assert.match(startWrapper, /web_server_skipped_for_process_role/);
  assert.match(startWrapper, /initStreamingWSServer/);
  assert.match(startWrapper, /startCoordinator/);
  assert.match(dockerfile, /PROCESS_ROLE/);
  assert.match(dockerfile, /exec yarn start/);
});
