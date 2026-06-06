import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const globalWrapupPath = new URL("../components/contact-center/GlobalWrapupSheet.jsx", import.meta.url);

async function source() {
  return readFile(globalWrapupPath, "utf8");
}

test("GlobalWrapupSheet recovers customer-first hangups from authoritative Wrapup status", async () => {
  const src = await source();

  assert.match(
    src,
    /new EventSource\(["']\/api\/user\/status-stream["']\)/,
    "wrapup sheet must listen to the same authoritative status stream as the header",
  );
  assert.match(
    src,
    /status\s*===\s*["']Wrapup["'][\s\S]{0,1200}addEventListener\(["']status_changed["']/,
    "when DB-authoritative status changes to Wrapup, the sheet must start recovery even if WebRTC did not emit a local disconnect",
  );
  assert.match(
    src,
    /recoverWrapupFromInteractions\(/,
    "Wrapup status recovery must inspect recent agent interactions for the completed answered call",
  );
  assert.match(
    src,
    /interaction\.state\s*!==\s*["']completed["']/,
    "recovery should only consider completed interactions",
  );
  assert.match(
    src,
    /return hasAnsweredEvidence\(interaction\)/,
    "recovery should only open when the completed interaction has positive answered evidence",
  );
  assert.match(
    src,
    /openWrapup\(candidate\.id/,
    "recovery must open the sheet for the recovered completed interaction",
  );
});

test("GlobalWrapupSheet has a polling safety net while agent is in Wrapup", async () => {
  const src = await source();

  assert.match(
    src,
    /setInterval\([\s\S]{0,700}recoverWrapupFromInteractions\([\s\S]{0,300}5000/,
    "lost SSE or browser WebRTC events must not permanently suppress the wrapup sheet",
  );
});

test("GlobalWrapupSheet polls the authoritative profile status so missed SSE still opens wrapup", async () => {
  const src = await source();

  assert.match(
    src,
    /fetch\(["']\/api\/user\/profile["'],\s*\{\s*cache:\s*["']no-store["']\s*\}\)/,
    "the wrapup sheet must read the same DB-authoritative profile status as the header",
  );
  assert.match(
    src,
    /const\s+profileStatus\s*=\s*data\?\.data\?\.status/,
    "profile polling must extract the current agent status from the profile response",
  );
  assert.match(
    src,
    /profileStatus\s*===\s*["']Wrapup["'][\s\S]{0,900}recoverWrapupFromInteractions\(/,
    "if the current profile status is already Wrapup, recovery must run without waiting for a status_changed SSE event",
  );
  assert.match(
    src,
    /setInterval\([\s\S]{0,900}loadAgentStatusForWrapupRecovery\([\s\S]{0,300}5000/,
    "while mounted, the sheet needs the same 5s status polling safety net as the header",
  );
});
