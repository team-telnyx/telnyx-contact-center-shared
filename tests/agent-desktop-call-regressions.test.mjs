import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("answering a routed WebRTC call remains a browser-side WebRTC action", async () => {
  for (const path of ["components/softphone.jsx", "components/softphone-mini.jsx"]) {
    const source = await read(path);
    const answerHandler = source.match(
      /function handleAnswerCall\(\)[\s\S]*?\n  }\n/,
    )?.[0];
    assert.ok(answerHandler, `${path} must expose the WebRTC answer handler`);
    assert.match(answerHandler, /activeCall\.answer\?\.\(\)/);
    assert.doesNotMatch(
      answerHandler,
      /\/api\/contact-center\/interactions\/.*\/answer/,
      `${path} must not bridge an already-ringing WebRTC leg again`,
    );
  }

});

test("outbound WebRTC calls rely on newCall to send exactly one invite", async () => {
  for (const path of [
    "components/softphone.jsx",
    "components/softphone-mini.jsx",
  ]) {
    const source = await read(path);
    assert.match(source, /client\.newCall\s*\(/, `${path} must create WebRTC calls`);
    assert.doesNotMatch(
      source,
      /call\.invite\?\.\(\)/,
      `${path} must not invite again after client.newCall()`,
    );
  }
  const transferModal = await read("components/contact-center/TransferModal.jsx");
  assert.equal(
    transferModal.match(/client\.newCall\s*\(/g)?.length,
    1,
    "a browser-originated consultation must create exactly one replacement WebRTC leg",
  );
  assert.doesNotMatch(
    transferModal,
    /call\.invite\?\.\(\)/,
    "the consultation must not send a second invite after client.newCall()",
  );
  assert.match(transferModal, /postCoreIntent/);
});

test("terminal outbound dialing errors show an error toast and clear the WebRTC call", async () => {
  const failureHelper = await read("lib/webrtc-dial-failure.js");
  for (const state of [
    "busy",
    "failed",
    "rejected",
    "declined",
    "unavailable",
    "no_answer",
    "timeout",
    "error",
  ]) {
    assert.ok(failureHelper.includes(`"${state}"`), state);
  }
  for (const path of ["components/softphone.jsx", "components/softphone-mini.jsx"]) {
    const source = await read(path);
    assert.match(source, /isWebrtcDialFailureState\(lowerState\)/);
    assert.match(source, /title:\s*"Call failed"/);
    assert.match(source, /variant:\s*"error"/);
    assert.match(source, /cancelUnstartedWebrtcIntent\(intentId\)/);
    assert.match(source, /updateStatus\("ended"\)/);
  }
});

test("Agent Assist metadata survives SSE to WebRTC correlation", async () => {
  const mini = await read("components/softphone-mini.jsx");
  const desktop = await read("components/contact-center/AgentDesktop.jsx");
  const lookup = await read("lib/helpers/lookup-call-info.js");
  const byCallControl = await read(
    "app/api/contact-center/interactions/by-call-control-id/route.js",
  );

  assert.match(mini, /storedInfo\?\.metadata[\s\S]*metadata:\s*metadata\.metadata/);
  assert.match(desktop, /\.\.\.\(storeCall\.metadata\s*\|\|\s*\{\}\)/);
  assert.match(lookup, /metadata\.metadata\s*=\s*interaction\.metadata/);
  assert.match(byCallControl, /findInteractionViewByCallControlId/);
  assert.match(byCallControl, /findInteractionViewByCallSessionId/);
});

test("GlobalWrapupSheet is the single authoritative wrap-up owner", async () => {
  const desktop = await read("components/contact-center/AgentDesktop.jsx");
  const global = await read("components/contact-center/GlobalWrapupSheet.jsx");

  assert.doesNotMatch(desktop, /\.openWrapup\(/);
  assert.match(global, /subscribeCoreSnapshot/);
  assert.match(global, /pendingWrapupFromSnapshot/);
  assert.match(global, /workflow_state\s*!==\s*["']wrapup["']/);
  assert.doesNotMatch(global, /wrapup_required|contact-center:wrapup-required/);
});
