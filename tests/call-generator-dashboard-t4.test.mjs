import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

async function src(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("call generator live dashboard (T4)", () => {
  it("SSE stream route is admin-gated with periodic snapshots", async () => {
    const code = await src("app/api/admin/call-generator/stream/route.js");
    assert.match(code, /isAdmin/);
    assert.match(code, /text\/event-stream/);
    assert.match(code, /setInterval\(sendUpdate, 2000\)/);
    assert.match(code, /cg_update/);
    assert.match(code, /addSseClient/);
    assert.match(code, /removeSseClient/);
    assert.match(code, /abort/);
  });

  it("snapshot query aggregates runs, per-run ledger stats and recent calls", async () => {
    const code = await src("app/api/admin/call-generator/stream/route.js");
    assert.match(code, /cg_runs/);
    assert.match(code, /cg_call_ledger/);
    assert.match(code, /statsByRun/);
    assert.match(code, /activeCalls/);
    assert.match(code, /runningRuns/);
  });

  it("dashboard view consumes the SSE stream via EventSource", async () => {
    const code = await src("components/contact-center/CallGeneratorDashboardView.jsx");
    assert.match(code, /EventSource/);
    assert.match(code, /cg_update/);
    assert.match(code, /\/api\/admin\/call-generator\/stream/);
    assert.match(code, /source\.close\(\)/);
  });

  it("dashboard shows live metric cards and connection state", async () => {
    const code = await src("components/contact-center/CallGeneratorDashboardView.jsx");
    assert.match(code, /Active calls/);
    assert.match(code, /Dialing/);
    assert.match(code, /Ringing/);
    assert.match(code, /Answered/);
    assert.match(code, /Running runs/);
    assert.match(code, /Reconnecting/);
  });

  it("dashboard exposes per-run Stop and Panic controls with confirmation", async () => {
    const code = await src("components/contact-center/CallGeneratorDashboardView.jsx");
    assert.match(code, /runAction\(run\.id, "stop"\)/);
    assert.match(code, /runAction\(run\.id, "panic"\)/);
    assert.match(code, /window\.confirm\("Panic stop/);
    assert.match(code, /PATCH/);
  });

  it("dashboard renders recent calls table with durations and results", async () => {
    const code = await src("components/contact-center/CallGeneratorDashboardView.jsx");
    assert.match(code, /Recent calls/);
    assert.match(code, /formatDuration/);
    assert.match(code, /hangup_cause/);
    assert.match(code, /to_number/);
    assert.match(code, /from_number/);
  });
});
