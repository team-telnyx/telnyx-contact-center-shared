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

  it("dashboard exposes per-run Stop and Panic controls with a custom confirm modal", async () => {
    const code = await src("components/contact-center/CallGeneratorDashboardView.jsx");
    assert.match(code, /runAction\(run\.id, "stop"\)/);
    assert.match(code, /runAction\(runId, "panic"\)/);
    // Panic uses the custom AlertDialog, never native window.confirm
    assert.doesNotMatch(code, /window\.confirm/);
    assert.match(code, /AlertDialog/);
    assert.match(code, /Panic stop this run\?/);
    assert.match(code, /setConfirmPanic/);
    assert.match(code, /PATCH/);
  });

  it("dashboard renders recent calls table with live durations, max and results", async () => {
    const code = await src("components/contact-center/CallGeneratorDashboardView.jsx");
    assert.match(code, /Recent calls/);
    // live ticking elapsed (1s) instead of a static formatDuration
    assert.match(code, /callElapsedSecs/);
    assert.match(code, /setNow\(Date\.now\(\)\)/);
    // duration shown alongside the effective max call duration
    assert.match(code, /Duration \/ Max/);
    assert.match(code, /max_duration_secs/);
    // color coding as the timer approaches the hangup
    assert.match(code, /durationToneClass/);
    assert.match(code, /remainingSecs <= 15/);
    assert.match(code, /remainingSecs <= 60/);
    assert.match(code, /hangup_cause/);
    assert.match(code, /to_number/);
    assert.match(code, /from_number/);
  });

  it("dashboard offers per-call Disconnect icons and a Disconnect all custom modal", async () => {
    const code = await src("components/contact-center/CallGeneratorDashboardView.jsx");
    assert.match(code, /Disconnect all/);
    assert.match(code, /cg-disconnect-all/);
    assert.match(code, /cg-disconnect-call/);
    assert.match(code, /IconPhoneOff/);
    // per-call icon only renders for active calls
    assert.match(code, /\["dialing", "ringing", "answered", "talking"\]\.includes\(call\.status\)/);
    // bulk action uses the custom confirm modal (no native window.confirm) and is disabled with no active calls
    assert.match(code, /setConfirmDisconnectAll\(true\)/);
    assert.match(code, /Disconnect all active calls\?/);
    assert.match(code, /totals\.activeCalls === 0/);
    assert.match(code, /\/api\/admin\/call-generator\/calls/);
  });

  it("stream snapshot surfaces the effective max call duration per call", async () => {
    const code = await src("app/api/admin/call-generator/stream/route.js");
    assert.match(code, /max_duration_secs/);
    // precedence: run config → scenario override → global settings → 120, clamped
    assert.match(code, /postAnswer,maxDurationSecs/);
    assert.match(code, /maxCallDurationSecs/);
    assert.match(code, /max_call_duration_secs/);
    assert.match(code, /GREATEST\(10, LEAST\(3600/);
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
