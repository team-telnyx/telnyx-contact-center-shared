import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// Codex review (0cbf7ffc, P2): executeMcpToolNode now unwraps the reference workflow's
// {result, error} envelope before storing mcp_response at runtime
// (mcp-tool-runner.js), but a saved testResponse.body written by
// McpToolNodeEditor still carries the raw envelope. Without the same
// unwrap here, the edge-mapping UI offers paths like
// mcp_response.result.contract_id, one level off from what a live call
// actually produces (mcp_response.contract_id), so a mapping built from
// one of those paths resolves to nothing at runtime.

test("EdgeVariableMapper imports and applies unwrapMcpResultEnvelope to a saved MCP Tool testResponse before deriving edge-mapping paths", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");
  assert.match(
    source,
    /import \{ unwrapMcpResultEnvelope \} from "@\/lib\/agent-assist\/slot-mcp-runner\.mjs";/,
  );

  const mcpBlock = source.slice(
    source.indexOf("if (isMcpToolNode)"),
    source.indexOf("if (isMcpToolNode)") + 2000,
  );
  assert.match(
    mcpBlock,
    /const \{ payload: responsePayload \} = unwrapMcpResultEnvelope\(rawResponsePayload\);/,
  );
  // extractPathsFromObject must run against the UNWRAPPED payload, not the
  // raw one straight off testResponse.body.
  assert.match(mcpBlock, /extractPathsFromObject\(responsePayload, responseVariable, 10\)/);
});
