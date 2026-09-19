import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// Codex review (0cbf7ffc, P2): the MCP Tool node's "Test" action
// (app/api/voice/flows/test-mcp-tool/route.js) only checked response.isError
// (the MCP-protocol layer) for success/failure, never the reference integration's own {result,
// error} envelope. A the reference workflow tool that returns a 200/non-isError response
// reporting a business-level failure (e.g. {result: null, error: "Contract
// not found"}) was reported here as success:true and persisted as the
// node's saved testResponse — contradicting live execution, which now
// (mcp-tool-runner.js) correctly routes the identical response to the
// node's error output.

test("test-mcp-tool route imports and applies unwrapMcpResultEnvelope, same as live execution", async () => {
  const source = await read("app/api/voice/flows/test-mcp-tool/route.js");
  assert.match(
    source,
    /import \{ unwrapMcpResultEnvelope \} from "@\/lib\/agent-assist\/slot-mcp-runner\.mjs";/,
  );
  assert.match(
    source,
    /const \{ payload: responsePayload, error: envelopeError \} = unwrapMcpResultEnvelope\(rawResponsePayload\);/,
  );
});

test("test-mcp-tool route reports failure for a MCP result envelope-level error, not just an MCP-protocol isError", async () => {
  const source = await read("app/api/voice/flows/test-mcp-tool/route.js");
  assert.match(source, /const isError = Boolean\(response\.isError\) \|\| Boolean\(envelopeError\);/);
  assert.match(source, /success: !isError,/);
  assert.match(source, /status: isError \? 502 : 200/);
});
