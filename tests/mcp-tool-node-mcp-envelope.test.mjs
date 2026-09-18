import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// the reference workflow wraps every tool result as {result, error} regardless of transport
// (JSON-RPC content[].text or the plain REST alternative), and reports
// failures INSIDE that envelope rather than as an MCP-protocol error — a
// 200/non-isError response can still be a failed call. The slot-mcp binding
// pipeline (slot-mcp-execute.js) already strips this envelope via
// unwrapMcpResultEnvelope before mapping outputs. The call-flow's own MCP Tool
// node (executeMcpToolNode) did not, so `mcp_response.<field>` on a pre-call
// the reference workflow lookup (e.g. get_phone_information) was always one level too shallow
// — the real fields sit under mcp_response.result.<field> — while the exact
// same tool's mid-call slot binding equivalent worked correctly.

test("executeMcpToolNode imports and applies unwrapMcpResultEnvelope, matching the slot-mcp binding pipeline", async () => {
  const source = await read("lib/mcp/mcp-tool-runner.js");
  assert.match(
    source,
    /import \{ unwrapMcpResultEnvelope \} from "@\/lib\/agent-assist\/slot-mcp-runner\.mjs";/,
  );
  assert.match(
    source,
    /const \{ payload: responsePayload, error: envelopeError \} = unwrapMcpResultEnvelope\(rawResponsePayload\);/,
  );
  assert.match(
    source,
    /const rawResponsePayload = getMcpResponseVariablePayload\(result\);/,
  );
});

test("a MCP result envelope-level error routes to the error output/variable, same as an MCP-protocol isError", async () => {
  const source = await read("lib/mcp/mcp-tool-runner.js");
  const fnStart = source.indexOf("export async function executeMcpToolNode");
  const fnBody = source.slice(fnStart, source.indexOf("\nexport ", fnStart + 1));

  assert.match(fnBody, /if \(envelopeError\) \{/);
  // Same output/branch shape as the pre-existing result.isError branch.
  assert.match(
    fnBody,
    /return \{\s*\n\s*success: true,\s*\n\s*output: 1,\s*\n\s*variables: \{ \[errorVariable\]: \{ message: envelopeError, response: rawResponsePayload \} \},\s*\n\s*\};/,
  );
});

test("the success path stores the UNWRAPPED payload as the response variable, not the raw {result, error} envelope", async () => {
  const source = await read("lib/mcp/mcp-tool-runner.js");
  const fnStart = source.indexOf("export async function executeMcpToolNode");
  const fnBody = source.slice(fnStart, source.indexOf("\nexport ", fnStart + 1));

  // The final success return still keys off `responsePayload` — now the
  // unwrapped one, not the raw MCP-protocol-layer-only payload — so
  // `mcp_response.<field>` resolves flat, e.g. mcp_response.contract_id.
  assert.match(fnBody, /\[responseVariable\]: responsePayload,/);
  assert.doesNotMatch(fnBody, /\[responseVariable\]: rawResponsePayload,/);
});

test("slot-mcp binding pipeline's own envelope unwrap is unchanged (regression guard)", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");
  assert.match(source, /unwrapMcpResultEnvelope\(getMcpResponseVariablePayload\(response\)\)/);
});
