import { workflowExpressionIssues } from "./assistant-workflow-expressions.mjs";
import { sourceText } from "../i18n/source-text.mjs";
import {
  ASSISTANT_TOOL_LIBRARY_SOURCE_KEY,
  ASSISTANT_TOOL_LIBRARY_SOURCE_VALUE,
} from "./tool-library.js";
import { validateTranscriptionOverride } from "./assistant-transcription.mjs";

// Workflow node types that can be stored in flow.nodes. Note: "assistant" is
// NOT a node type — an assistant handoff is expressed purely on the edge as
// target.type="assistant" (with assistant_id + voice_mode + position). The
// canvas synthesizes a virtual node from that edge target so the
// handoff is visible and selectable, but it is never persisted to flow.nodes.
export const WORKFLOW_NODE_TYPES = ["prompt", "speak", "tool"];

// Canonical Telnyx AI Assistant system variables (single source of truth).
// These are the variables exposed to AI Assistant conversation/instructions/voice
// fields — the same set the assistant editor (AgentTab) uses. Workflow node and
// variable panels import this instead of redefining their own list.
export const OPENCLAW_SYSTEM_VARIABLES = [
  { name: "telnyx_current_time", description: "The current date and time in UTC", example: "Monday, February 24 2025 04:04:15 PM UTC" },
  { name: "telnyx_conversation_channel", description: "This can be phone_call, web_call, or sms_chat", example: "phone_call" },
  { name: "telnyx_agent_target", description: "The phone number, SIP URI, or other identifier associated with the agent.", example: "+13128675309" },
  { name: "telnyx_end_user_target", description: "The phone number, SIP URI, or other identifier associated with the end user", example: "+15551234567" },
  { name: "telnyx_shaken_stir_attestation", description: "The SHAKEN/STIR attestation level for inbound phone calls, if available. This can be a, b, or c.", example: "a" },
  { name: "call_control_id", description: "The call control ID for the call, if applicable", example: "v3:u5OAKGEPT3Dx8SZSSDRWEMdNH2OripQhO" },
];

export const ASSISTANT_SYSTEM_VARIABLE_NAMES = OPENCLAW_SYSTEM_VARIABLES.map((variable) => variable.name);


export function createWorkflowNode(type = "prompt", position = { x: 160, y: 120 }) {
  if (!WORKFLOW_NODE_TYPES.includes(type)) {
    throw new Error(`Unsupported workflow node type: ${type}`);
  }

  const id = `n_${type}_${randomId()}`;
  const base = {
    id,
    type,
    name: type === "speak" ? "Speak node" : "Prompt node",
    position: {
      x: Number(position?.x || 0),
      y: Number(position?.y || 0),
    },
  };

  if (type === "tool") return {...base, name: "Tool node", shared_tool_id: ""};

  if (type === "speak") {
    return {
      ...base,
      message: "",
    };
  }

  return {
    ...base,
    instructions: "",
    instructions_mode: "append",
  };
}

export function createDefaultConversationFlow() {
  const node = createWorkflowNode("prompt", { x: 120, y: 120 });
  return {
    start_node_id: node.id,
    nodes: [node],
    edges: [],
  };
}

export function getSharedToolId(tool) {
  if (!tool || typeof tool !== "object") return "";

  // Library API rows use `id`; assistant tools copied from the library are
  // explicitly marked. Do not treat every Telnyx `tool_id` as shared because
  // inline tools can also be returned with local tool_id values.
  if (tool.shared_tool_id || tool.library_tool_id) {
    return String(tool.shared_tool_id || tool.library_tool_id);
  }
  if (
    tool[ASSISTANT_TOOL_LIBRARY_SOURCE_KEY] === ASSISTANT_TOOL_LIBRARY_SOURCE_VALUE ||
    tool.shared === true ||
    tool.is_library_tool === true ||
    String(tool.tool_id || "").startsWith("tool_shared_")
  ) {
    return String(tool.tool_id || tool.id || "");
  }
  if (tool.tool_id && !tool.type && !tool.webhook && !tool.transfer && !tool.handoff) {
    return String(tool.tool_id);
  }
  if (tool.id && !tool.tool_id) {
    return String(tool.id);
  }
  return "";
}

export function getToolDisplayName(tool, tUi = sourceText) {
  return (
    tool?.name ||
    tool?.webhook?.name ||
    tool?.transfer?.name ||
    tool?.handoff?.name ||
    tool?.display_name ||
    tool?.type ||
    tUi("Unnamed tool")
  );
}

export function getInlineToolsBlockingWorkflow(values = {}) {
  const tools = Array.isArray(values?.tools) ? values.tools : [];
  return tools
    .filter((tool) => !getSharedToolId(tool))
    .map((tool) => ({
      ...tool,
      name: getToolDisplayName(tool),
    }));
}

export function normalizeWorkflowCanvasLayout(flow, options = {}) {
  const rawNodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const rawEdges = Array.isArray(flow?.edges) ? flow.edges : [];

  // Migrate legacy assistant nodes (from the short-lived palette entry in
  // PR #1257) to edge targets. A legacy node has type:"assistant" in
  // flow.nodes with an assistant_id. We remove it from nodes and rewrite
  // any edge that targets it to target.type="assistant".
  const legacyAssistantNodes = rawNodes.filter((n) => n?.type === "assistant");
  let migratedEdges = rawEdges;
  if (legacyAssistantNodes.length > 0) {
    const legacyById = new Map(legacyAssistantNodes.map((n) => [String(n.id), n]));
    migratedEdges = rawEdges.map((edge) => {
      if (edge.target?.type === "node" && legacyById.has(String(edge.target.node_id))) {
        const legacy = legacyById.get(String(edge.target.node_id));
        return {
          ...edge,
          target: {
            type: "assistant",
            assistant_id: legacy.assistant_id,
            voice_mode: legacy.voice_mode || "unified",
            position: legacy.position || { x: 0, y: 0 },
          },
        };
      }
      return edge;
    });
  }
  const nodes = legacyAssistantNodes.length > 0
    ? rawNodes.filter((n) => n?.type !== "assistant")
    : rawNodes;

  if (!nodes.length) {
    return { ...(flow || {}), nodes: [], edges: migratedEdges };
  }

  const anchorX = options.anchorX ?? 40;
  const anchorY = options.anchorY ?? 40;
  const viewportPadding = options.viewportPadding ?? 40;
  const normalizedNodes = nodes.map((node, index) => ({
    ...node,
    id: String(node?.id || `node_${index + 1}`),
    position: {
      x: Number.isFinite(Number(node?.position?.x)) ? Number(node.position.x) : 120 + index * 320,
      y: Number.isFinite(Number(node?.position?.y)) ? Number(node.position.y) : 220,
    },
  }));

  const anchorNode =
    normalizedNodes.find((node) => String(node.id) === String(flow?.start_node_id || "")) ||
    normalizedNodes[0];
  const anchorSourceX = Number(anchorNode.position.x || 0);
  const anchorSourceY = Number(anchorNode.position.y || 0);

  const anchoredNodes = normalizedNodes.map((node) => ({
    ...node,
    position: {
      x: anchorX + (Number(node.position.x || 0) - anchorSourceX),
      y: anchorY + (Number(node.position.y || 0) - anchorSourceY),
    },
  }));

  const minX = Math.min(...anchoredNodes.map((node) => node.position.x));
  const minY = Math.min(...anchoredNodes.map((node) => node.position.y));
  const offsetX = minX < viewportPadding ? viewportPadding - minX : 0;
  const offsetY = minY < viewportPadding ? viewportPadding - minY : 0;

  return {
    ...(flow || {}),
    nodes: anchoredNodes.map((node) => ({
      ...node,
      position: {
        x: node.position.x + offsetX,
        y: node.position.y + offsetY,
      },
    })),
    edges: migratedEdges,
  };
}

// Structural reachability, independent of conditions: isolated cycles are just
// as unreachable as cards with no connections. The starting step needs no input.
export function reachableWorkflowSteps(flow) {
  const ids = new Set((flow?.nodes || []).map(node => String(node.id)));
  const reachable = new Set();
  const pending = ids.has(String(flow?.start_node_id)) ? [String(flow.start_node_id)] : [];
  const destinations = new Map();
  for (const edge of flow?.edges || []) {
    if (edge.target?.type !== "node") continue;
    const source = String(edge.start_node_id);
    if (!destinations.has(source)) destinations.set(source, []);
    destinations.get(source).push(String(edge.target.node_id));
  }
  while (pending.length) {
    const id = pending.pop();
    if (reachable.has(id) || !ids.has(id)) continue;
    reachable.add(id);
    pending.push(...(destinations.get(id) || []));
  }
  return reachable;
}

export function validateConversationFlow(flow, options = {}, tUi = sourceText) {
  const errors = [];
  if (!flow || typeof flow !== "object") {
    return [tUi("Workflow is missing.")];
  }

  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow.edges) ? flow.edges : [];
  const nodeLabel = node => node?.name || tUi("Step {number}", {number: nodes.indexOf(node) + 1});
  const nodeIds = new Set();
  const edgeIds = new Set();
  const reachable = reachableWorkflowSteps(flow);

  if (!nodes.length) errors.push(tUi("Workflow must contain at least one node."));
  if (!flow.start_node_id) errors.push(tUi("Workflow requires a start node."));

  for (const node of nodes) {
    if (!node?.id) {
      errors.push(tUi("A workflow step could not be identified. Remove it and add it again."));
      continue;
    }
    if (nodeIds.has(node.id)) errors.push(tUi("The step “{name}” is duplicated. Remove the extra step and add it again.", {name: nodeLabel(node)}));
    nodeIds.add(node.id);
    if (flow.start_node_id && !reachable.has(String(node.id))) {
      errors.push(tUi("The step “{name}” is not connected to the start. Connect it to a reachable step or remove it.", {name: nodeLabel(node)}));
    }

    // Legacy assistant nodes (from the short-lived palette entry) are
    // migrated to edge targets in normalizeWorkflowCanvasLayout, so don't
    // reject them here — the migration strips them before validation.
    if (!WORKFLOW_NODE_TYPES.includes(node.type || "prompt") && node.type !== "assistant") {
      errors.push(tUi("The step “{name}” is not supported. Remove it and add a supported step.", {name: nodeLabel(node)}));
    }
    if (!options.allowInheritedInstructions && (node.type || "prompt") === "prompt" && !String(node.instructions || "").trim()) {
      errors.push(tUi("Prompt node {value0} requires instructions.", {value0: nodeLabel(node)}));
    }
    if (node.type === "tool" && !String(node.shared_tool_id || "").trim()) errors.push(tUi("A shared tool is required."));
    if (node.type === "speak" && !String(node.message || "").trim()) {
      errors.push(tUi("Speak node {value0} requires a message.", {value0: nodeLabel(node)}));
    }
    for (const issue of validateTranscriptionOverride(node.transcription, tUi)) {
      errors.push(tUi("Node {value0}: {value1}", {value0: nodeLabel(node), value1: issue}));
    }
    if (Array.isArray(node.shared_tool_ids) && options.sharedToolIds instanceof Set) {
      for (const toolId of node.shared_tool_ids) {
        if (!options.sharedToolIds.has(toolId)) {
          errors.push(tUi("The step “{name}” uses a tool that is no longer in the shared library. Choose another tool.", {name: nodeLabel(node)}));
        }
      }
    }
  }

  if (flow.start_node_id && !nodeIds.has(flow.start_node_id)) {
    errors.push(tUi("Workflow start node must reference an existing node."));
  }

  for (const [index] of (flow._assistantDrafts || []).entries()) {
    errors.push(tUi("Assistant step {number} is not connected. Connect it to a reachable step or remove it before saving.", {number: nodes.length + edges.filter(edge => edge.target?.type === "assistant").length + index + 1}));
  }

  for (const [index, edge] of edges.entries()) {
    const source = nodes.find(node => node.id === edge.start_node_id);
    const connection = source
      ? tUi("Connection {number} from “{name}”", {number: index + 1, name: nodeLabel(source)})
      : tUi("Connection {number}", {number: index + 1});
    if (!edge?.id) {
      errors.push(tUi("{connection}: this connection could not be identified. Remove it and reconnect the steps.", {connection}));
    } else if (edgeIds.has(edge.id)) {
      errors.push(tUi("{connection}: this connection is duplicated. Remove it and reconnect the steps.", {connection}));
    } else {
      edgeIds.add(edge.id);
    }

    if (!nodeIds.has(edge.start_node_id)) {
      errors.push(tUi("{connection}: choose an existing starting step.", {connection}));
    }
    if (edge.target?.type === "node" && !nodeIds.has(edge.target.node_id)) {
      errors.push(tUi("{connection}: choose an existing destination step.", {connection}));
    }
    if (edge.target?.type === "assistant" && !String(edge.target.assistant_id || "").trim()) {
      errors.push(tUi("{connection}: choose the assistant that should receive the conversation.", {connection}));
    }
    if (!edge.target || !edge.target.type) {
      errors.push(tUi("{connection}: choose a destination.", {connection}));
    }

    const condition = edge.condition || {};
    if (condition.type === "default" && !["speak", "tool"].includes(source?.type)) {
      errors.push(tUi("Default conditions are only valid from speak or tool nodes."));
    }
    if (condition.type === "llm" && !String(condition.prompt || "").trim()) {
      errors.push(tUi("{connection}: describe when the conversation should follow this connection.", {connection}));
    }
    if (condition.type === "expression" && !condition.expression) {
      errors.push(tUi("{connection}: add a variable comparison to decide when to follow this connection.", {connection}));
    }
    if (condition.type === "expression" && condition.expression) {
      errors.push(...workflowExpressionIssues(condition.expression).map(issue => tUi("{connection}: {issue}", {connection, issue: tUi(issue)})));
    }
  }

  // Runtime constraint: a speak node must have at least one outgoing edge so
  // the flow can continue after the message is delivered (Telnyx error 10015).
  for (const node of nodes) {
    if (node.type === "speak") {
      const outgoing = edges.filter((edge) => edge.start_node_id === node.id);
      if (outgoing.length === 0) {
        errors.push(tUi("Speak node {value0} must have at least one outgoing edge.", {value0: nodeLabel(node)}));
      }
    }
  }

  for (const node of nodes.filter((candidate) => ["speak", "tool"].includes(candidate.type))) {
    const outgoingDefaults = edges.filter(
      (edge) => edge.start_node_id === node.id && edge.condition?.type === "default"
    );
    const outgoing = edges.filter((edge) => edge.start_node_id === node.id);
    if (outgoing.length > 0 && outgoingDefaults.length !== 1) {
      errors.push(tUi("Step “{value0}” needs exactly one default connection to continue automatically.", {value0: nodeLabel(node)}));
    }
  }

  return errors;
}

// Per-node validation: returns an array of human-readable issues for a single
// node. Used by the canvas to show a warning icon on nodes with missing config.
// Includes reachability so disconnected steps are highlighted immediately.
export function validateWorkflowNode(node, flow, tUi = sourceText) {
  const issues = [];
  if (!node?.id) return issues;
  const type = node.type || "prompt";
  const reachable = reachableWorkflowSteps(flow);
  const source = type === "assistant"
    ? flow?.edges?.find(edge => String(edge.id) === String(node.handoff_id))?.start_node_id
    : node.id;
  if (!reachable.has(String(source))) issues.push(tUi("This step is not connected to the start. Connect it to a reachable step."));
  if (type === "prompt" && !String(node.instructions || "").trim()) {
    issues.push(tUi("Instructions are required."));
  }
  if (type === "speak" && !String(node.message || "").trim()) {
    issues.push(tUi("Message is required."));
  }
  if (type === "tool" && !node.shared_tool_id) issues.push(tUi("A shared tool is required."));
  issues.push(...validateTranscriptionOverride(node.transcription, tUi));
  // Assistant nodes exist only on the canvas, but incomplete handoffs must
  // be visibly flagged while their edge target is being configured.
  if (type === "assistant" && !String(node.assistant_id || "").trim()) {
    issues.push(tUi("Choose a target assistant."));
  }
  // Runtime constraint: a speak node must have at least one outgoing edge.
  if (type === "speak") {
    const edges = Array.isArray(flow?.edges) ? flow.edges : [];
    const outgoing = edges.filter((edge) => edge.start_node_id === node.id);
    if (outgoing.length === 0) {
      issues.push(tUi("At least one outgoing edge is required."));
    }
  }
  return issues;
}

// Per-edge validation: returns an array of human-readable issues for a single
// edge. Used by the canvas/properties to flag edges with missing config.
export function validateWorkflowEdge(edge, flow, tUi = sourceText) {
  const issues = [];
  if (!edge) return issues;
  const condition = edge.condition || {};
  if (edge.target?.type === "assistant" && !String(edge.target.assistant_id || "").trim()) {
    issues.push(tUi("Choose a target assistant."));
  }
  if (condition.type === "llm" && !String(condition.prompt || "").trim()) {
    issues.push(tUi("LLM prompt is required."));
  }
  if (condition.type === "expression") {
    if (!condition.expression) {
      issues.push(tUi("A comparison expression is required."));
    } else {
      issues.push(...workflowExpressionIssues(condition.expression).map(issue => tUi(issue)));
    }
  }
  return issues;
}

export function buildComparisonExpression({ variable, op = "==", value, valueType = "string" }) {
  let literalType = "string_literal";
  let literalValue = value ?? "";
  if (valueType === "number") {
    literalType = "number_literal";
    literalValue = Number(value || 0);
  } else if (valueType === "boolean") {
    literalType = "bool_literal";
    literalValue = value === true || value === "true";
  }
  return {
    type: "comparison",
    left: { type: "variable", name: variable || "" },
    op,
    right: { type: literalType, value: literalValue },
  };
}

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}
