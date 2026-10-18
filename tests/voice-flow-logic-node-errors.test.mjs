import test from "node:test";
import assert from "node:assert/strict";
import { loadRoute } from "./helpers/route-harness.mjs";

// Logic and HTTP nodes record their error events with the flow id from the
// execution state. They used to read an undeclared `executionState`, so every
// error path threw a ReferenceError instead of reporting the real problem.
async function loadEngine({ evaluateExpression } = {}) {
  const events = [];
  const engine = await loadRoute("lib/voice-flow-engine.js", {
    "@/config/voice-flow-nodes.js": { getNodeById: (id) => ({ id }) },
    "@/lib/call-monitor-store.js": {
      addNodeActivation: () => {},
      addNodeExecutionEvent: (...args) => events.push(args),
    },
    "@/lib/variable-utils.js": { replaceTemplateVariables: (value) => value },
    "@/lib/expression-engine.js": {
      evaluateExpression: evaluateExpression || (() => ({ success: true, result: "" })),
      evaluateCondition: () => ({ success: true, result: true }),
    },
    "./voice/logging.mjs": {
      voiceRuntimePayload: (value) => value,
      voiceFlowLogger: { debug() {}, info() {}, warn() {}, error() {} },
    },
  });
  return { engine, events };
}

const executionState = { flowId: "flow-1", variables: {}, globalVariables: {} };
const nodeOf = (nodeType, config = {}) => ({
  id: `${nodeType}-node`,
  type: "customNode",
  data: { nodeType, label: nodeType, config },
});

for (const [nodeType, config, expectedError] of [
  ["condition", {}, "Condition node missing operator"],
  ["switch", {}, "Switch node missing variable to evaluate"],
  ["set_variable", {}, "Set variable node missing variable name"],
  ["set_variable", { variableName: "x" }, "Set variable node missing expression"],
  ["logic_gate", {}, "Logic gate node missing operator"],
  ["http_request_action", {}, "HTTP request node missing URL"],
]) {
  test(`${nodeType} config error is reported with the flow id: ${expectedError}`, async () => {
    const { engine, events } = await loadEngine();
    const result = await engine.executeFlowNode(
      nodeOf(nodeType, config),
      "call-1",
      {},
      executionState,
    );

    assert.equal(result.success, false);
    assert.equal(result.error, expectedError);
    assert.equal(events.length, 1);
    const [callControlId, eventNodeType, nodeId, , details, success, , flowId] = events[0];
    assert.equal(callControlId, "call-1");
    assert.equal(eventNodeType, nodeType);
    assert.equal(nodeId, `${nodeType}-node`);
    assert.deepEqual(details, { error: expectedError });
    assert.equal(success, false);
    assert.equal(flowId, "flow-1");
  });
}

test("set_variable evaluation failure reaches its catch block with the flow id", async () => {
  const { engine, events } = await loadEngine({
    evaluateExpression: () => {
      throw new Error("expression exploded");
    },
  });
  const result = await engine.executeFlowNode(
    nodeOf("set_variable", { variableName: "x", expression: "1 +" }),
    "call-1",
    {},
    executionState,
  );

  assert.deepEqual(result, { success: false, error: "expression exploded" });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][4], { error: "expression exploded" });
  assert.equal(events[0][7], "flow-1");
});
