# Client State Merge Flow for Enqueue Node

This document shows where `client_state` is merged and where the enqueue command is called.

## Flow Overview

1. **Webhook Handler** merges `client_state` with routing params (required_skills, priority)
2. **Flow Engine** executes the node and calls Telnyx API
3. **Telnyx API** receives the enqueue request with merged `client_state`

## Location 1: Client State Merge (Webhook Handler)

### File: `app/api/voice/webhook/incoming/[flowId]/route.js`

#### Location A: In `nodesToExecute.map` (lines 1105-1145)

```javascript
// Line 1105-1145
nodesToExecute.map(async (nextNode) => {
  // Prepare node with client_state for flow tracking
  // Merge existing client_state (may contain routing params) with flow tracking
  const existingConfig = nextNode.data?.config || {};
  const flowTracking = { flowId, currentNodeId: nextNode.id };

  // If node has existing client_state (e.g., from EnqueueNodeEditor with routing params), merge it
  let mergedClientState = flowTracking;
  if (existingConfig.client_state) {
    try {
      const decoded = Buffer.from(
        existingConfig.client_state,
        "base64"
      ).toString();
      const existing = JSON.parse(decoded);
      // Merge: existing first (preserves routing params like required_skills, priority), then flow tracking
      mergedClientState = { ...existing, ...flowTracking };

      // Debug logging for enqueue nodes
      if (nextNode.data?.nodeType === "enqueue") {
        console.log(
          "[FlowWebhook] Enqueue node - existing client_state:",
          existing
        );
        console.log(
          "[FlowWebhook] Enqueue node - merged client_state:",
          mergedClientState
        );
      }
    } catch (err) {
      console.warn(
        "[FlowWebhook] Failed to decode existing client_state:",
        err
      );
    }
  }

  const configuredNextNode = {
    ...nextNode,
    data: {
      ...nextNode.data,
      config: {
        ...existingConfig,
        // Merge client_state: preserve routing params, add flow tracking
        client_state: Buffer.from(JSON.stringify(mergedClientState)).toString(
          "base64"
        ),
      },
    },
  };

  // Pass configuredNextNode to executeFlowNode
  const result = await executeFlowNode(
    configuredNextNode, // <-- This has the merged client_state
    payload.call_control_id,
    body,
    executionState
  );
});
```

#### Location B: In `executeNodeChain` (lines 1342-1395)

```javascript
// Line 1342-1395
// Configure node with client_state for flow tracking
// Merge existing client_state (may contain routing params) with flow tracking
const existingConfig = nextNode.data?.config || {};
const flowTracking = { flowId, currentNodeId: nextNode.id };

// If node has existing client_state (e.g., from EnqueueNodeEditor with routing params), merge it
let mergedClientState = flowTracking;
if (existingConfig.client_state) {
  try {
    const decoded = Buffer.from(
      existingConfig.client_state,
      "base64"
    ).toString();
    const existing = JSON.parse(decoded);
    // Merge: existing first (preserves routing params like required_skills, priority), then flow tracking
    mergedClientState = { ...existing, ...flowTracking };

    // Debug logging for enqueue nodes
    if (nextNode.data?.nodeType === "enqueue") {
      console.log(
        "[FlowWebhook] Enqueue node - existing client_state:",
        existing
      );
      console.log(
        "[FlowWebhook] Enqueue node - merged client_state:",
        mergedClientState
      );
    }
  } catch (err) {
    console.warn("[FlowWebhook] Failed to decode existing client_state:", err);
  }
}

const configuredNode = {
  ...nextNode,
  data: {
    ...nextNode.data,
    config: {
      ...existingConfig,
      // Merge client_state: preserve routing params, add flow tracking
      client_state: Buffer.from(JSON.stringify(mergedClientState)).toString(
        "base64"
      ),
    },
  },
};

// Pass configuredNode to executeFlowNode
const result = await executeFlowNode(
  configuredNode, // <-- This has the merged client_state
  callControlId,
  body,
  nodeExecutionState
);
```

## Location 2: Node Execution (Flow Engine)

### File: `lib/voice-flow-engine.js`

#### Function: `executeFlowNode` (lines 52-261)

```javascript
// Line 76: Read config from node (which should have merged client_state)
const config = node.data?.config || {};

// Line 100-104: Process config (replace variables, etc.)
const processedConfig = replaceVariables(configWithDefaults, mergedVariables);

// Line 106-123: Debug logging for enqueue nodes
if (nodeType === "enqueue") {
  console.log("[FlowEngine] Enqueue node config:", {
    queue_name: processedConfig.queue_name,
    has_client_state: !!processedConfig.client_state,
    routing_skills: processedConfig.routing_skills,
    routing_priority: processedConfig.routing_priority,
  });
  if (processedConfig.client_state) {
    try {
      const decoded = Buffer.from(
        processedConfig.client_state,
        "base64"
      ).toString();
      const clientStateObj = JSON.parse(decoded);
      console.log(
        "[FlowEngine] Enqueue node client_state decoded:",
        clientStateObj
      );
    } catch (err) {
      console.log("[FlowEngine] Failed to decode enqueue client_state:", err);
    }
  }
}

// Line 209-215: Call Telnyx API with processedConfig
const result = await callTelnyxAction(
  executionState?.flowId || null,
  nodeDef.telnyxAction, // "enqueue"
  callControlId,
  processedConfig // <-- This includes client_state with merged routing params
);
```

## Location 3: Enqueue API Call

### File: `lib/voice-flow-engine.js`

#### Function: `callTelnyxAction` (lines 482-1046)

```javascript
// Line 613-618: Enqueue case
case "enqueue":
  url = buildTelnyxV2Url(
    `/calls/${encodeURIComponent(callControlId)}/actions/enqueue`
  );
  method = "POST";
  break;

// Line 492: body contains all params including client_state
let body = { ...params };

// Line 1000-1007: Make API call
const response = await fetch(url, {
  method,
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),  // <-- body includes client_state with merged routing params
});
```

## Expected Flow

1. **Flow saved** with enqueue node config containing:

   - `client_state`: base64 encoded `{"required_skills": {...}, "priority": ...}`
   - `routing_skills`: array of skills
   - `routing_priority`: priority value

2. **Webhook received** → Handler loads flow from database

3. **Webhook handler** (Location 1):

   - Reads `existingConfig.client_state` from node config
   - Decodes it: `{"required_skills": {...}, "priority": ...}`
   - Merges with flow tracking: `{...existing, ...flowTracking}`
   - Result: `{"required_skills": {...}, "priority": ..., "flowId": "...", "currentNodeId": "..."}`
   - Sets merged `client_state` on `configuredNode`

4. **Flow engine** (Location 2):

   - Receives `configuredNode` with merged `client_state`
   - Reads `config = node.data?.config` (includes merged `client_state`)
   - Processes config and passes to `callTelnyxAction`

5. **Telnyx API call** (Location 3):

   - `body` includes `client_state` with merged routing params
   - Sent to Telnyx: `POST /calls/{call_control_id}/actions/enqueue`

6. **Telnyx webhook** (`call.enqueued`):
   - Should contain merged `client_state` with `required_skills` and `priority`

## Debugging

Check console logs for:

- `[FlowWebhook] Enqueue node - existing client_state:` - Shows what's in the node config
- `[FlowWebhook] Enqueue node - merged client_state:` - Shows the merged result
- `[FlowEngine] Enqueue node config:` - Shows what executeFlowNode receives
- `[FlowEngine] Enqueue node client_state decoded:` - Shows decoded client_state before API call

## Potential Issues

1. **Node config doesn't have client_state**: Check if `EnqueueNodeEditor` is saving `client_state` correctly
2. **Merge not happening**: Check if `existingConfig.client_state` exists when merge runs
3. **Decode error**: Check if base64 decode is failing silently
4. **Node not configured**: Check if `configuredNode` is actually being passed to `executeFlowNode`
