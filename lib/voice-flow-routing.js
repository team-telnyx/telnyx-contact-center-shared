import { VOICE_FLOW_NODES } from "../config/voice-flow-nodes.js";

/**
 * Find all next nodes connected to a given node for a specific event.
 *
 * When event is omitted, this intentionally returns every outgoing edge for
 * legacy immediate-continuation callers. Webhook initiators should pass the
 * current event so event-specific handles (for example call.answered) are not
 * executed on call.initiated.
 */
export function findNextEdges(flow, nodeId, event = null) {
  const edges = flow.edges || [];
  const nodes = flow.nodes || [];

  if (!event) {
    return edges.filter((e) => e.source === nodeId);
  }

  const sourceNode = nodes.find((n) => n.id === nodeId);
  if (!sourceNode) return [];

  const nodeDef = VOICE_FLOW_NODES[sourceNode.data?.nodeType];
  const outputEvents =
    sourceNode.data?.dynamicOutputEvents || nodeDef?.outputEvents || [];

  return edges.filter((e) => {
    if (e.source !== nodeId) return false;

    if (!e.sourceHandle || e.sourceHandle === "default") return true;

    if (e.sourceHandle === event) return true;

    if (e.sourceHandle && e.sourceHandle.startsWith("output-")) {
      const outputIndex = parseInt(e.sourceHandle.replace("output-", ""), 10);
      if (!isNaN(outputIndex) && outputEvents[outputIndex] === event) {
        return true;
      }
    }

    return false;
  });
}

export function findNextNodes(flow, nodeId, event = null) {
  const nodes = flow.nodes || [];
  const matchingEdges = findNextEdges(flow, nodeId, event);

  return matchingEdges
    .map((edge) => nodes.find((n) => n.id === edge.target))
    .filter(Boolean);
}
