import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// Codex review (0557da1d54, P2): executeMcpToolNode now unwraps the reference workflow's
// {result, error} envelope before storing the response variable at runtime
// (mcp-tool-runner.js), but this expression-builder helper — which surfaces
// a saved MCP Tool test response as autocomplete/preview options in the flow
// editor — still only applied getMcpResponseVariablePayload. A saved the reference workflow
// test response would show/validate `mcp_response.result.contract_id` in
// the editor, one level off from `mcp_response.contract_id`, which is what
// actually resolves during a live call. Expressions authored against the
// editor's (stale) shape would silently resolve to undefined at runtime.

test("buildExpressionTestPayloadOptions imports and applies unwrapMcpResultEnvelope for the mcp_tool option", async () => {
  const source = await read("lib/voice-flow-expression-test-payloads.js");
  assert.match(
    source,
    /import \{ unwrapMcpResultEnvelope \} from "@\/lib\/agent-assist\/slot-mcp-runner\.mjs";/,
  );

  const mcpBlockStart = source.indexOf('if (nodeType === "mcp_tool")');
  const mcpBlockEnd = source.indexOf('if (nodeType === "data_action_buttons")', mcpBlockStart);
  const mcpBlock = source.slice(mcpBlockStart, mcpBlockEnd > -1 ? mcpBlockEnd : mcpBlockStart + 2000);
  assert.match(
    mcpBlock,
    /const \{ payload: unwrappedResponsePayload \} = unwrapMcpResultEnvelope\(getMcpResponseVariablePayload\(testResponse\)\);/,
  );
  // The response variable option must key off the unwrapped payload, not the
  // raw (possibly still-enveloped) one.
  assert.match(mcpBlock, /\[responseVariable\]: unwrappedResponsePayload,/);
});
