# Client State Flow - Parameter Storage and Retrieval

## Overview
This document describes how routing parameters are stored in `client_state` by call flow nodes and how they are retrieved by webhook handlers.

## Parameter Storage in Call Flow Nodes

### Set Queue Options Node
**Stores in `client_state`** (base64-encoded JSON):
```javascript
{
  queue_name: string,           // Queue name (if not using variable)
  call_priority: number,         // Call priority 1-5 stars (if not using variable)
  required_skills: {             // Skills object (if not using variable)
    "skill_name": proficiency    // proficiency: 1-5 stars
  }
}
```

**Location**: `components/voice-flow/SetQueueOptionsNodeEditor.jsx:234-256`

**Notes**:
- Only stores values if NOT using variables
- Encodes as base64 JSON: `btoa(JSON.stringify(clientStateObj))`
- Merges with existing client_state (preserves other fields)

---

### Enqueue Call Node

#### When `useQueueOptions = false`:
**Stores in `client_state`** (base64-encoded JSON):
```javascript
{
  required_skills: {             // Only for Skill-based routing
    "skill_name": proficiency    // proficiency: 1-5 stars
  },
  call_priority: number          // Call priority 1-5 stars
}
```

**Also stores in node config**:
- `queue_name`: Direct value (not in client_state)
- `routing_skills`: Array format (not in client_state)
- `call_priority`: Direct value (also in client_state)

**Location**: `components/voice-flow/EnqueueNodeEditor.jsx:291-356`

#### When `useQueueOptions = true`:
- **Does NOT store** client_state in node config
- **Reads from** call's existing client_state (set by Set Queue Options node)
- Voice flow engine reads `queue_name` from client_state and uses it for Telnyx API call

**Location**: `lib/voice-flow-engine.js:265-337`

---

## Parameter Retrieval in Webhook Handler

### handleContactCenterEnqueue()
**Reads from `client_state`** (webhook parameter):
```javascript
// Parse client_state from webhook
const decoded = JSON.parse(Buffer.from(clientState, "base64").toString());
routingMetadata = decoded;

// Available fields:
routingMetadata.queue_name        // ✅ Used by voice flow engine (not webhook handler)
routingMetadata.call_priority     // ✅ Used for interaction.priority
routingMetadata.required_skills   // ✅ Used for routing
```

**Location**: `lib/contact-center/webhook-handler.js:422-431`

**Usage**:
1. **Call Priority**: 
   - Read from `routingMetadata.call_priority` (line 517-520)
   - Sets `interaction.priority` (line 532, 568)
   - Passed to `routeCall()` as `priority` (line 638) ✅ FIXED

2. **Required Skills**:
   - Read from `routingMetadata.required_skills` (line 529, 564, 637)
   - Stored in `interaction.required_skills` (line 529, 564)
   - Passed to `routeCall()` as `required_skills` (line 637)

3. **Queue Name**:
   - NOT read from client_state in webhook handler
   - Comes from Telnyx webhook `queueName` parameter
   - Telnyx API receives queue_name from client_state when `useQueueOptions=true`

**Location**: `lib/contact-center/webhook-handler.js:406-641`

---

## Flow Diagram

### Scenario 1: Set Queue Options → Enqueue Call (useQueueOptions=true)

```
1. Set Queue Options Node
   └─> Stores in client_state:
       - queue_name: "SUPPORT"
       - call_priority: 5
       - required_skills: {"IoT": 4}

2. Enqueue Call Node (useQueueOptions=true)
   └─> Reads from client_state:
       - queue_name → Used for Telnyx API call
       - call_priority → Passed in client_state
       - required_skills → Passed in client_state
   └─> Telnyx API receives:
       - queue_name: "SUPPORT" (from client_state)
       - client_state: {queue_name, call_priority, required_skills}

3. Telnyx Webhook (call.enqueued)
   └─> Returns:
       - queueName: "SUPPORT"
       - client_state: {queue_name, call_priority, required_skills}

4. Webhook Handler (handleContactCenterEnqueue)
   └─> Parses client_state:
       - routingMetadata.call_priority → Sets interaction.priority
       - routingMetadata.required_skills → Sets interaction.required_skills
   └─> Calls routeCall():
       - priority: routingMetadata.call_priority ✅
       - required_skills: routingMetadata.required_skills ✅
```

### Scenario 2: Enqueue Call (useQueueOptions=false)

```
1. Enqueue Call Node (useQueueOptions=false)
   └─> Stores in node config:
       - queue_name: "SUPPORT" (direct)
       - call_priority: 5 (direct + client_state)
       - routing_skills: [...] (direct)
   └─> Stores in client_state:
       - call_priority: 5
       - required_skills: {"IoT": 4} (if Skill-based)

2. Telnyx API receives:
   - queue_name: "SUPPORT" (from node config)
   - client_state: {call_priority, required_skills}

3. Telnyx Webhook (call.enqueued)
   └─> Returns:
       - queueName: "SUPPORT"
       - client_state: {call_priority, required_skills}

4. Webhook Handler (handleContactCenterEnqueue)
   └─> Parses client_state:
       - routingMetadata.call_priority → Sets interaction.priority
       - routingMetadata.required_skills → Sets interaction.required_skills
   └─> Calls routeCall():
       - priority: routingMetadata.call_priority ✅
       - required_skills: routingMetadata.required_skills ✅
```

---

## Parameter Mapping

| Parameter | Set Queue Options | Enqueue Call | Webhook Handler | routeCall() |
|-----------|------------------|--------------|-----------------|-------------|
| `queue_name` | ✅ client_state | ✅ node config OR client_state | ❌ (from webhook) | ❌ (not used) |
| `call_priority` | ✅ client_state | ✅ node config + client_state | ✅ client_state | ✅ as `priority` |
| `required_skills` | ✅ client_state | ✅ client_state (if Skill-based) | ✅ client_state | ✅ as `required_skills` |

---

## Issues Found and Fixed

### ✅ Fixed: Priority Parameter Mismatch
**Issue**: Webhook handler was passing `routingMetadata.priority` to `routeCall()`, but call flow nodes store `call_priority` in client_state.

**Fix**: Changed to pass `routingMetadata.call_priority` (or fallback to `interaction.priority` or `queue.default_call_priority`).

**Location**: `lib/contact-center/webhook-handler.js:636-641`

**Before**:
```javascript
priority: routingMetadata.priority || 0,  // ❌ Wrong - doesn't exist
```

**After**:
```javascript
const callPriorityForRouting = 
  routingMetadata.call_priority || 
  interaction?.priority || 
  queue.default_call_priority || 
  3;
priority: callPriorityForRouting,  // ✅ Correct
```

---

## Verification Checklist

### ✅ Set Queue Options Node
- [x] Stores `queue_name` in client_state
- [x] Stores `call_priority` in client_state
- [x] Stores `required_skills` in client_state
- [x] Base64 encodes client_state
- [x] Merges with existing client_state

### ✅ Enqueue Call Node
- [x] Stores `call_priority` in client_state (when not using queue options)
- [x] Stores `required_skills` in client_state (when Skill-based, not using queue options)
- [x] Reads from client_state when `useQueueOptions=true`
- [x] Voice flow engine reads `queue_name` from client_state when `useQueueOptions=true`

### ✅ Webhook Handler
- [x] Parses client_state from webhook
- [x] Reads `call_priority` from routingMetadata
- [x] Reads `required_skills` from routingMetadata
- [x] Sets `interaction.priority` from `call_priority`
- [x] Passes `priority` to `routeCall()` correctly ✅ FIXED
- [x] Passes `required_skills` to `routeCall()` correctly

### ✅ Routing Engine
- [x] Receives `callData.priority` (1-5 stars)
- [x] Receives `callData.required_skills`
- [x] Uses priority in Priority-based routing
- [x] Uses required_skills in Skills-based routing

---

## Summary

**All parameters are correctly stored and retrieved**:

1. ✅ **Call Priority**: Stored as `call_priority` in client_state → Read correctly → Passed to routing engine as `priority`
2. ✅ **Required Skills**: Stored as `required_skills` in client_state → Read correctly → Passed to routing engine
3. ✅ **Queue Name**: Stored as `queue_name` in client_state → Used by voice flow engine → Passed to Telnyx API → Returned in webhook

**Fixed Issue**: Webhook handler now correctly passes `call_priority` as `priority` to routing engine.

---

**Last Updated**: 2026-01-27
**Status**: ✅ All Parameters Correctly Stored and Retrieved
