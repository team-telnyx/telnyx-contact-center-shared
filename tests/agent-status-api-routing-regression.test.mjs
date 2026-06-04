import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const agentDesktopPath = new URL(
  "../components/contact-center/AgentDesktop.jsx",
  import.meta.url,
);
const userStatusPath = new URL(
  "../lib/contact-center/user-status.js",
  import.meta.url,
);

async function source(path) {
  return readFile(path, "utf8");
}

test("Agent Desktop status updates use the implemented agent/status API method", async () => {
  const src = await source(agentDesktopPath);
  const updateStatusBlock = src.slice(
    src.indexOf("async function updateAgentStatus"),
    src.indexOf("function OutboundCampaignRecord"),
  );

  assert.match(updateStatusBlock, /fetch\("\/api\/contact-center\/agent\/status"/);
  assert.match(
    updateStatusBlock,
    /method:\s*"PUT"/,
    "Agent Desktop must call PUT because /api/contact-center/agent/status does not implement POST",
  );
  assert.doesNotMatch(
    updateStatusBlock,
    /method:\s*"POST"/,
    "POST currently returns 405 and silently prevents status-driven routing",
  );
});

test("Available status refresh still offers queued calls even when status is unchanged", async () => {
  const src = await source(userStatusPath);
  const unchangedStatusBlock = src.slice(
    src.indexOf("if (previousStatus && previousStatus === status)"),
    src.indexOf("// If agent is manually changing status"),
  );

  assert.match(
    unchangedStatusBlock,
    /if \(status === "Available"\)[\s\S]*offerQueuedCallForAgent\(\{ userId: String\(userId\) \}\)[\s\S]*return;/,
    "unchanged Available status must still retry queued-call offering before returning",
  );
});
