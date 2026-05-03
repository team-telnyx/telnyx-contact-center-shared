/**
 * In-memory storage for call monitoring events
 * Stores webhooks and commands for active calls
 * Also tracks real-time flow execution (node/edge activations)
 */

// Use global to persist across hot reloads in development
if (!global.callMonitorData) {
  global.callMonitorData = new Map();
}
const callMonitorData = global.callMonitorData;

// Track monitor run/session ids back to their flow so node execution events can
// be discovered by the flow-scoped Call Monitor even when older call sites only
// pass a callControlId to addNodeExecutionEvent(). The key can be a real Telnyx
// call_control_id or a synthetic monitor id such as form:<submission_id>.
if (!global.callMonitorFlowByRunId) {
  global.callMonitorFlowByRunId = new Map();
}
const callMonitorFlowByRunId = global.callMonitorFlowByRunId;

function rememberFlowForRun(callControlId, flowId) {
  if (callControlId && flowId) {
    callMonitorFlowByRunId.set(callControlId, flowId);
  }
}

function resolveFlowForRun(callControlId, flowId = null) {
  return flowId || callMonitorFlowByRunId.get(callControlId) || null;
}

// Store for real-time flow execution events (node/edge activations)
// Map<flowId, Array<{type: 'node'|'edge', id: string, timestamp: string, callControlId: string}>>
if (!global.flowExecutionEvents) {
  global.flowExecutionEvents = new Map();
}
const flowExecutionEvents = global.flowExecutionEvents;

/**
 * Add a webhook event to the monitor
 * Uses occurred_at from webhook payload as timestamp
 * @param {string} callControlId - The call control ID
 * @param {string} eventType - The event type
 * @param {Object} payload - The webhook payload
 * @param {string} flowId - Optional flow ID to associate with this event
 */
export function addWebhookEvent(
  callControlId,
  eventType,
  payload,
  flowId = null,
) {
  if (!callControlId) return;

  rememberFlowForRun(callControlId, flowId);

  if (!callMonitorData.has(callControlId)) {
    callMonitorData.set(callControlId, []);
  }

  const events = callMonitorData.get(callControlId);

  // Extract occurred_at from webhook payload (Telnyx format)
  // Fallback to current time if not available
  const occurredAt = payload?.data?.occurred_at || new Date().toISOString();

  const event = {
    id: `webhook_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    event_type: eventType,
    payload,
    timestamp: occurredAt,
    call_control_id: callControlId,
    direction: "received",
    ...(flowId && { flow_id: flowId }),
  };
  events.push(event);
}

/**
 * Add a sent command to the monitor
 * Uses execution time as timestamp
 * @param {string} callControlId - The call control ID
 * @param {string} action - The action name
 * @param {Object} request - The request payload
 * @param {Object} response - The response payload
 * @param {string} timestamp - Optional timestamp
 * @param {string} flowId - Optional flow ID to associate with this event
 */
export function addCommandEvent(
  callControlId,
  action,
  request,
  response,
  timestamp = null,
  flowId = null,
) {
  if (!callControlId) return;

  rememberFlowForRun(callControlId, flowId);

  if (!callMonitorData.has(callControlId)) {
    callMonitorData.set(callControlId, []);
  }

  const events = callMonitorData.get(callControlId);

  // Use provided timestamp if available, otherwise use current time
  const event = {
    id: `command_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    event_type: action,
    payload: { request, response },
    timestamp: timestamp || new Date().toISOString(),
    call_control_id: callControlId,
    direction: "sent",
    ...(flowId && { flow_id: flowId }),
  };
  events.push(event);
}

/**
 * Add a node execution event to the monitor
 * Used for logical nodes (condition, switch, set_variable, http_request, etc.)
 * @param {string} callControlId - The call control ID
 * @param {string} nodeType - Type of the node (e.g., "set_variable", "http_request_action")
 * @param {string} nodeId - The node ID
 * @param {string} nodeLabel - The node label/name
 * @param {Object} executionDetails - Details about the execution
 * @param {boolean} success - Whether the execution was successful
 * @param {number} output - The output index taken
 * @param {string} flowId - Optional flow ID to associate with this event
 */
export function addNodeExecutionEvent(
  callControlId,
  nodeType,
  nodeId,
  nodeLabel,
  executionDetails,
  success,
  output,
  flowId = null,
) {
  if (!callControlId) {
    return;
  }

  const resolvedFlowId = resolveFlowForRun(callControlId, flowId);
  rememberFlowForRun(callControlId, resolvedFlowId);

  if (!callMonitorData.has(callControlId)) {
    callMonitorData.set(callControlId, []);
  }

  const events = callMonitorData.get(callControlId);

  const event = {
    id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    event_type: `node_execution:${nodeType}`,
    payload: {
      node_id: nodeId,
      node_type: nodeType,
      node_label: nodeLabel,
      success,
      output,
      details: executionDetails,
    },
    timestamp: new Date().toISOString(),
    call_control_id: callControlId,
    direction: "executed",
    ...(resolvedFlowId && { flow_id: resolvedFlowId }),
  };

  events.push(event);
}

/**
 * Get all events for a specific call
 */
export function getCallEvents(callControlId) {
  if (!callControlId) return [];
  return callMonitorData.get(callControlId) || [];
}

/**
 * Get all events across all calls (for a specific number)
 */
export function getAllEvents() {
  const allEvents = [];

  for (const [callId, events] of callMonitorData.entries()) {
    allEvents.push(...events);
  }

  // Sort by timestamp
  return allEvents.sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
  );
}

/**
 * Get all events for a specific flow ID
 * @param {string} flowId - The flow ID to filter by
 * @returns {Array} Array of events filtered by flowId
 */
export function getFlowEvents(flowId) {
  if (!flowId) return [];

  const allEvents = [];

  for (const [callId, events] of callMonitorData.entries()) {
    const flowEvents = events.filter((event) => event.flow_id === flowId);
    allEvents.push(...flowEvents);
  }

  // Sort by timestamp
  return allEvents.sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
  );
}

/**
 * Clear events for a specific call
 */
export function clearCallEvents(callControlId) {
  if (callControlId) {
    callMonitorData.delete(callControlId);
    callMonitorFlowByRunId.delete(callControlId);
  }
}

/**
 * Clear all monitoring data
 */
export function clearAllEvents() {
  callMonitorData.clear();
  callMonitorFlowByRunId.clear();
}

/**
 * Cleanup old calls (older than 1 hour)
 */
export function cleanupOldCalls() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  for (const [callControlId, events] of callMonitorData.entries()) {
    if (events.length === 0) {
      callMonitorData.delete(callControlId);
      callMonitorFlowByRunId.delete(callControlId);
      continue;
    }

    // Check if the last event is older than 1 hour
    const lastEvent = events[events.length - 1];
    const lastEventTime = new Date(lastEvent.timestamp).getTime();

    if (lastEventTime < oneHourAgo) {
      callMonitorData.delete(callControlId);
      callMonitorFlowByRunId.delete(callControlId);
    }
  }
}

// Cleanup old calls every 10 minutes
setInterval(cleanupOldCalls, 10 * 60 * 1000);

/**
 * Add a node activation event for real-time monitoring
 * @param {string} flowId - Flow ID
 * @param {string} nodeId - Node ID being executed
 * @param {string} callControlId - Call control ID
 */
export function addNodeActivation(flowId, nodeId, callControlId) {
  if (!flowId || !nodeId) return;

  if (!flowExecutionEvents.has(flowId)) {
    flowExecutionEvents.set(flowId, []);
  }

  const events = flowExecutionEvents.get(flowId);
  const event = {
    type: "node",
    id: nodeId,
    callControlId,
    timestamp: new Date().toISOString(),
  };

  events.push(event);

  // Keep only last 100 events per flow
  if (events.length > 100) {
    events.shift();
  }
}

/**
 * Add an edge transition event for real-time monitoring
 * @param {string} flowId - Flow ID
 * @param {string} sourceNodeId - Source node ID
 * @param {string} targetNodeId - Target node ID
 * @param {string} callControlId - Call control ID
 */
export function addEdgeActivation(
  flowId,
  sourceNodeId,
  targetNodeId,
  callControlId,
) {
  if (!flowId || !sourceNodeId || !targetNodeId) return;

  if (!flowExecutionEvents.has(flowId)) {
    flowExecutionEvents.set(flowId, []);
  }

  const events = flowExecutionEvents.get(flowId);
  const event = {
    type: "edge",
    sourceId: sourceNodeId,
    targetId: targetNodeId,
    callControlId,
    timestamp: new Date().toISOString(),
  };

  events.push(event);

  // Keep only last 100 events per flow
  if (events.length > 100) {
    events.shift();
  }
}

/**
 * Get and clear flow execution events (for SSE polling)
 * @param {string} flowId - Flow ID
 * @returns {Array} Array of execution events
 */
export function getFlowExecutionEvents(flowId) {
  if (!flowId) return [];

  const events = flowExecutionEvents.get(flowId) || [];
  // Clear events after reading (they've been sent to client)
  flowExecutionEvents.set(flowId, []);

  return events;
}

/**
 * Clear all flow execution events for a specific flow
 * @param {string} flowId - Flow ID
 */
export function clearFlowExecutionEvents(flowId) {
  if (flowId) {
    flowExecutionEvents.delete(flowId);
  }
}
