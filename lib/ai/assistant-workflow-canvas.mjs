import { normalizeWorkflowCanvasLayout } from "./assistant-conversation-workflow.mjs";

const workflowNodeLabel = type => ({prompt: "Prompt node", speak: "Speak node", tool: "Tool node", assistant: "Assistant node"}[type] || "Prompt node");

export function defaultWorkflowNodePosition(index) {
  return { x: 40 + index * 320, y: 40 };
}

export function normalizeWorkflowNode(node, index = 0) {
  const type = ["speak", "tool"].includes(node?.type) ? node.type : "prompt";
  const id = String(node.id || `n_${type}_${index + 1}`);
  return {
    ...node,
    id,
    type,
    name: node?.name || workflowNodeLabel(type),
    position: node.position || defaultWorkflowNodePosition(index),
  };
}

// Deterministic canvas id for the virtual node synthesized from an edge
// whose target.type === "assistant". The id is stable across renders so
// ReactFlow keeps the node mounted and the user's drag is preserved.
export function virtualAssistantNodeId(edgeId) {
  return `assistant-handoff:${String(edgeId)}`;
}

export function toReactFlowNodes(flow, options = {}) {
  const displayFlow = options.normalize === true ? normalizeWorkflowCanvasLayout(flow) : flow;
  const realNodes = (displayFlow?.nodes || []).map((node, index) => {
    const normalized = normalizeWorkflowNode(node, index);
    return {
      id: String(node.id || normalized.id),
      type: "customNode",
      position: node.position || defaultWorkflowNodePosition(index),
      data: {
        node: normalized,
        nodeType: normalized.type,
        label: normalized.name || workflowNodeLabel(normalized.type),
        nodeId: normalized.id,
        nodeNumber: index + 1,
        isStart: String(displayFlow.start_node_id || "") === normalized.id,
      },
    };
  });

  // Each handoff belongs to an edge. Its canvas identity must survive selecting
  // or changing an assistant, including drafts that have no target yet.
  const edges = [...(displayFlow?.edges || []), ...(displayFlow?._assistantDrafts || [])];
  const virtualNodes = [];
  const occupiedPositions = new Set(realNodes.map(node => `${node.position.x}:${node.position.y}`));
  let virtualIndex = realNodes.length + 1;
  for (const edge of edges) {
    const target = edge.target;
    if (!target || target.type !== "assistant") continue;
    const aid = String(target.assistant_id || "");
    const virtualId = virtualAssistantNodeId(edge.id);
    const savedPosition = target.position || { x: 320, y: 320 + virtualIndex * 160 };
    const position = {x: Number(savedPosition.x || 0), y: Number(savedPosition.y || 0)};
    // Old invisible placeholders could share exactly the same coordinates.
    // Reveal every handoff without mutating the loaded draft.
    while (occupiedPositions.has(`${position.x}:${position.y}`)) position.y += 160;
    occupiedPositions.add(`${position.x}:${position.y}`);
    virtualNodes.push({
      id: virtualId,
      type: "customNode",
      position: { x: Number(position.x || 0), y: Number(position.y || 0) },
      // Dragging persists the position on the edge target, never in flow.nodes.
      draggable: true,
      data: {
        node: {
          id: virtualId,
          handoff_id: String(edge.id),
          type: "assistant",
          name: "Assistant node",
          assistant_id: aid,
          voice_mode: target.voice_mode || "distinct",
          position: { x: Number(position.x || 0), y: Number(position.y || 0) },
        },
        nodeNumber: virtualIndex,
        nodeType: "assistant",
        label: "Assistant node",
        nodeId: virtualId,
        isVirtualAssistant: true,
        edgeId: String(edge.id),
        assistantId: aid,
        voiceMode: target.voice_mode || "distinct",
      },
    });
    virtualIndex += 1;
  }

  return [...realNodes, ...virtualNodes];
}

export function toReactFlowEdges(flow) {
  return (flow?.edges || [])
    .filter((edge) => edge.target?.type === "node" || edge.target?.type === "assistant")
    .map((edge) => {
      const targetNodeId =
        edge.target?.type === "assistant"
          ? virtualAssistantNodeId(edge.id)
          : String(edge.target?.node_id || "");
      return {
        id: String(edge.id || `e_${edge.start_node_id}_${targetNodeId}`),
        source: String(edge.start_node_id),
        target: targetNodeId,
        sourceHandle: "output-0",
        targetHandle: "input-execute",
        animated: edge.condition?.type === "llm",
        type: "workflowEdge",
        data: { edge },
        style: { stroke: edge.condition?.type === "default" ? "#64748b" : "#00E3AA", strokeWidth: 2 },
      };
    });
}

export function reactFlowToConversationFlow({ flow, nodes, edges }) {
  const byId = new Map((flow?.nodes || []).map((node) => [String(node.id), node]));

  // Separate real workflow nodes (prompt/speak) from virtual assistant nodes
  // synthesized from edge targets. Only real nodes are persisted to flow.nodes.
  const realRfNodes = [];
  // Map canvas node id → { position, assistant_id, voice_mode } for virtual
  // assistant nodes, so edges can read back assistant_id + voice_mode + the
  // dragged canvas position when persisting.
  const virtualAssistantByNodeId = new Map();
  for (const rfNode of nodes) {
    const n = rfNode.data?.node || {};
    if (n.type === "assistant") {
      virtualAssistantByNodeId.set(String(rfNode.id), {
        id: String(rfNode.data.edgeId),
        assistantId: n.assistant_id,
        voiceMode: n.voice_mode || "distinct",
        position: rfNode.position || { x: 0, y: 0 },
      });
    } else {
      realRfNodes.push(rfNode);
    }
  }

  const nextNodes = realRfNodes.map((node, index) => {
    const position = node.position || defaultWorkflowNodePosition(index);
    return {
      ...(byId.get(String(node.id)) || node.data.node),
      id: String(node.id),
      type: node.data?.nodeType || node.data?.node?.type || "prompt",
      name: node.data?.label || node.data?.node?.name || workflowNodeLabel(node.data?.nodeType),
      position: {
        x: Number(position.x || 0),
        y: Number(position.y || 0),
      },
    };
  });

  const edgeById = new Map((flow?.edges || []).map((edge) => [String(edge.id), edge]));
  const canvasIds = new Set(nodes.map(node => String(node.id)));
  const nextEdges = edges.filter(edge => canvasIds.has(String(edge.source)) && canvasIds.has(String(edge.target))).map((edge) => {
    const existing = edgeById.get(String(edge.id));
    const targetNodeId = String(edge.target);
    const virtual = virtualAssistantByNodeId.get(targetNodeId);
    if (virtual) {
      // Edge targets a virtual assistant node — persist as
      // target.type="assistant" with the canvas position so Telnyx remembers
      // where the handoff node was placed.
      return {
        ...(existing || edge.data?.edge || {}),
        id: String(edge.id),
        start_node_id: String(edge.source),
        target: {
          ...(existing?.target || edge.data?.edge?.target || {}),
          type: "assistant",
          assistant_id: virtual.assistantId,
          voice_mode: virtual.voiceMode,
          position: {
            x: Number(virtual.position.x || 0),
            y: Number(virtual.position.y || 0),
          },
        },
      };
    }
    // Otherwise keep the original target if it existed (preserves
    // target.type="assistant" on edges that haven't been reconnected), else
    // default to a plain node target.
    return {
      ...(existing || edge.data?.edge || {}),
      id: String(edge.id),
      start_node_id: String(edge.source),
      target: existing?.target || { type: "node", node_id: targetNodeId },
    };
  });
  const connectedIds = new Set(nextEdges.map(edge => String(edge.id)));
  const drafts = [...virtualAssistantByNodeId.values()].filter(node => !connectedIds.has(node.id)).map(node => ({
    id: node.id,
    target: {type: "assistant", assistant_id: node.assistantId, voice_mode: node.voiceMode, position: node.position},
    // Keep a previously edited condition when the user disconnects a handoff.
    condition: edgeById.get(node.id)?.condition || flow?._assistantDrafts?.find(draft => draft.id === node.id)?.condition,
  }));
  const {_assistantDrafts, ...baseFlow} = flow || {};
  return {
    ...baseFlow,
    ...(drafts.length ? {_assistantDrafts: drafts} : {}),
    start_node_id: String(nextNodes.some(node => node.id === flow?.start_node_id) ? flow.start_node_id : nextNodes[0]?.id || ""),
    nodes: nextNodes,
    edges: nextEdges,
  };
}

export function defaultConnectionCondition(flow, sourceNodeId, excludedEdgeId) {
  const source = flow.nodes.find(node => String(node.id) === String(sourceNodeId));
  const hasDefault = flow.edges.some(edge => edge.id !== excludedEdgeId && String(edge.start_node_id) === String(sourceNodeId) && edge.condition?.type === "default");
  return ["speak", "tool"].includes(source?.type) && !hasDefault
    ? {type: "default"}
    : {type: "llm", prompt: ""};
}

export function addAssistantHandoff(flow, {position, id = `e_${globalThis.crypto.randomUUID()}`} = {}) {
  // Telnyx stores handoffs as edge targets. Disconnected cards belong only to
  // the editor draft; no edge exists until the user explicitly connects one.
  const drafts = flow._assistantDrafts || [];
  const targetPosition = position || defaultWorkflowNodePosition(toReactFlowNodes(flow).length);
  return {...flow, _assistantDrafts: [...drafts, {
    id, target: {type: "assistant", assistant_id: "", voice_mode: "unified", position: targetPosition},
  }]};
}

export function updateAssistantHandoff(flow, id, patch) {
  const existing = flow.edges.find(edge => edge.id === id) || flow._assistantDrafts?.find(draft => draft.id === id);
  if (!existing) return flow;
  const next = {...existing, ...patch, target: {...existing.target, ...patch.target}};
  const {_assistantDrafts, ...base} = flow;
  const drafts = (_assistantDrafts || []).filter(draft => draft.id !== id);
  const edges = flow.edges.filter(edge => edge.id !== id);
  if (next.start_node_id && flow.nodes.some(node => node.id === next.start_node_id)) {
    const source = flow.nodes.find(node => node.id === next.start_node_id);
    const previousCondition = existing.condition?.type === "default" && !["speak", "tool"].includes(source?.type) ? null : existing.condition;
    next.condition = patch.condition || previousCondition || defaultConnectionCondition(flow, next.start_node_id, id);
    // Preserve the order of existing transitions when editing their settings.
    const index = flow.edges.findIndex(edge => edge.id === id);
    edges.splice(index < 0 ? edges.length : index, 0, next);
  } else {
    delete next.start_node_id;
    drafts.push(next);
  }
  return {...base, edges, ...(drafts.length ? {_assistantDrafts: drafts} : {})};
}

// ReactFlow v11 discards measured dimensions when controlled nodes are replaced.
// Keep them for existing nodes so fitView continues to work after hydration/save.
export function hydrateWorkflowCanvasNodes(currentNodes, flow) {
  const measured = new Map(currentNodes.map(node => [node.id, node]));
  return toReactFlowNodes(flow).map(node => {
    const existing = measured.get(node.id);
    return existing ? {...node, width: existing.width, height: existing.height} : node;
  });
}
