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

  it("dashboard offers per-call Disconnect icons and a Disconnect all button", async () => {
    const code = await src("components/contact-center/CallGeneratorDashboardView.jsx");
    assert.match(code, /Disconnect all/);
    assert.match(code, /cg-disconnect-all/);
    assert.match(code, /cg-disconnect-call/);
    assert.match(code, /IconPhoneOff/);
    // per-call icon only renders for active calls
    assert.match(code, /\["dialing", "ringing", "answered", "talking"\]\.includes\(call\.status\)/);
    // bulk action requires confirmation and is disabled with no active calls
    assert.match(code, /window\.confirm\(`Disconnect ALL/);
    assert.match(code, /totals\.activeCalls === 0/);
    assert.match(code, /\/api\/admin\/call-generator\/calls/);
  });

  it("calls API exposes single disconnect and disconnect_all endpoints", async () => {
    const itemCode = await src("app/api/admin/call-generator/calls/[id]/route.js");
    assert.match(itemCode, /export async function PATCH/);
    assert.match(itemCode, /disconnectGeneratedCall/);
    assert.match(itemCode, /const \{ id \} = await params/);
    assert.match(itemCode, /requireAdmin/);
    const listCode = await src("app/api/admin/call-generator/calls/route.js");
    assert.match(listCode, /export async function POST/);
    assert.match(listCode, /disconnect_all/);
    assert.match(listCode, /disconnectActiveCalls/);
    assert.match(listCode, /requireAdmin/);
  });

  it("engine disconnect helpers hang up gracefully without force-failing ledger rows", async () => {
    const code = await src("lib/call-generator/engine.mjs");
    assert.match(code, /export async function disconnectGeneratedCall/);
    assert.match(code, /export async function disconnectActiveCalls/);
    assert.match(code, /manual_disconnect/);
    // unlike panicStop, disconnect must not mark rows failed — the webhook finalizes
    const disconnectSection = code.slice(code.indexOf("disconnectGeneratedCall"));
    assert.doesNotMatch(disconnectSection, /markLedgerStatus\(pool, (row\.id|ledgerId), "failed"/);
  });
});
