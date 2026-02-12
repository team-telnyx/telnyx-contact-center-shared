# AI to Agent Workflow Handoff - Implementation Plan

## Executive Summary

Implementacja bezszwowego przekazywania stanu workflow z AI Assistanta do agenta w contact center. Gdy klient rozmawia z AI assistentem i prosi o transfer do żywego agenta, zebrane dane (sloty, etapy konwersacji) są automatycznie odzwierciedlone w workflow widocznym dla agenta.

## Current State Analysis

### Existing Infrastructure

1. **Workflows** (`aa_workflows`, `aa_workflow_stages`, `aa_workflow_items`)
   - Definicja etapów konwersacji i slotów do zebrania
   - Powiązanie z AI Assistant via `ai_assistant_id`
   - Model LLM per workflow (`llm_model`)

2. **AI Assistant Creation** (`/api/ai/assistants`)
   - Tworzenie asystentów z workflow via `generateWorkflowInstructions()`
   - Sync instrukcji przy update workflow (`/api/admin/workflows/[id]/update-assistant`)

3. **Agent Assist Session** (`aa_workflow_sessions`, `aa_workflow_item_status`)
   - Śledzenie stanu workflow per interaction
   - Status itemów: `pending`, `completed`, `skipped`
   - Wypełnione sloty w `slots_filled` (JSONB)

4. **Call Transfer with X-AI-Call-ID**
   - Transfer z AI na agenta przekazuje `X-AI-Call-ID` header
   - System zapisuje `ai_call_control_id` w interaction metadata
   - Możliwość pobrania historii konwersacji AI

5. **Telnyx Conversations Insights API**
   - Insight Templates z `json_schema` i `webhook`
   - Insight Groups agregujące wiele insights
   - Webhook `call.conversation_insights.generated` po zakończeniu rozmowy
   - Assistant config: `insight_settings.insight_group_id`

---

## Proposed Solution Architecture

### Approach: Telnyx Insights with Webhook

**Wybór: Structured Insights z JSON Schema + Webhook**

Zamiast parsować tekstowe podsumowanie przez LLM, wykorzystujemy natywną funkcjonalność Telnyx Insights:

1. **Insight Group per Workflow** - każdy workflow z AI assistant ma własną grupę insights
2. **3 Insight Templates per Group**:
   - **`workflow_slots`** - wszystkie sloty workflow jako jeden structured JSON
   - **`call_summary`** - podsumowanie rozmowy w markdown
   - **`sentiment_analysis`** - analiza sentymentu w markdown
3. **Webhook Delivery** - Telnyx wysyła dane na nasz endpoint po transferze/hangup
4. **Pre-populate Agent Session** - webhook przetwarza dane i aktualizuje workflow session

### Why This Approach?

| Approach | Pros | Cons |
|----------|------|------|
| **Insights + Webhook** ✅ | Structured data, real-time delivery, no extra LLM calls, native Telnyx feature | Requires insight setup per workflow |
| Text Summary + LLM | Simple setup | Extra LLM call, parsing errors, latency |
| Poll Conversation Messages | Full control | Complex, requires polling, race conditions |

### Insight Group Structure

```
Insight Group: "WF: {workflow_name}"
├── Insight 1: workflow_slots (JSON schema)
│   └── Extracts all slots as structured object
├── Insight 2: call_summary (text/markdown)
│   └── Human-readable conversation summary
└── Insight 3: sentiment_analysis (text/markdown)
    └── Customer sentiment throughout call
```

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        WORKFLOW CREATION/UPDATE                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. Admin creates/edits workflow with stages and slots                   │
│                          │                                               │
│                          ▼                                               │
│  2. System creates Insight Group for workflow                            │
│     POST /ai/conversations/insight-groups                                │
│     {name: "WF: {workflow_name}", webhook: "{our_endpoint}"}             │
│                          │                                               │
│                          ▼                                               │
│  3. Create 3 Insight Templates and assign to group:                      │
│                                                                          │
│     a) WORKFLOW SLOTS (structured JSON)                                  │
│        POST /ai/conversations/insights                                   │
│        {                                                                 │
│          name: "workflow_slots",                                         │
│          instructions: "Extract slot values from conversation...",       │
│          json_schema: {                                                  │
│            type: "object",                                               │
│            properties: {                                                 │
│              slots: {                                                    │
│                type: "object",                                           │
│                properties: {                                             │
│                  "{slot_name}": {                                        │
│                    type: "object",                                       │
│                    properties: {                                         │
│                      value: {...},                                       │
│                      confidence: {type: "number"},                       │
│                      source_utterance: {type: "string"}                  │
│                    }                                                     │
│                  },                                                      │
│                  ... (for each slot in workflow)                         │
│                }                                                         │
│              },                                                          │
│              completed_stages: {type: "array", items: {type: "string"}}  │
│            }                                                             │
│          }                                                               │
│        }                                                                 │
│                                                                          │
│     b) CALL SUMMARY (markdown text)                                      │
│        POST /ai/conversations/insights                                   │
│        {                                                                 │
│          name: "call_summary",                                           │
│          instructions: "Provide a summary... Use markdown formatting..." │
│        }                                                                 │
│                                                                          │
│     c) SENTIMENT ANALYSIS (markdown text)                                │
│        POST /ai/conversations/insights                                   │
│        {                                                                 │
│          name: "sentiment_analysis",                                     │
│          instructions: "Analyze sentiment... Use markdown formatting..." │
│        }                                                                 │
│                                                                          │
│     → Assign all 3 to group via /insight-groups/{id}/insights/{id}/assign│
│                          │                                               │
│                          ▼                                               │
│  4. Create/Update AI Assistant with insight_settings                     │
│     POST /ai/assistants                                                  │
│     {                                                                    │
│       ...existing config...,                                             │
│       insight_settings: {                                                │
│         insight_group_id: "{group_id}"                                   │
│       }                                                                  │
│     }                                                                    │
│                          │                                               │
│                          ▼                                               │
│  5. Store insight IDs in aa_workflows:                                   │
│     - insight_group_id                                                   │
│     - insight_slots_id                                                   │
│     - insight_summary_id                                                 │
│     - insight_sentiment_id                                               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        RUNTIME: CALL FLOW                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. Customer calls AI Assistant                                          │
│     → AI collects data per workflow instructions                         │
│     → Slots filled during conversation                                   │
│                          │                                               │
│                          ▼                                               │
│  2. Customer requests transfer to human agent                            │
│     → AI initiates transfer with X-AI-Call-ID header                     │
│                          │                                               │
│            ┌─────────────┴─────────────┐                                 │
│            ▼                           ▼                                 │
│  3a. Call arrives at CC           3b. Telnyx generates insights          │
│      with X-AI-Call-ID                 (async, ~2-10 sec after transfer) │
│      → Interaction created             → Webhook queued                  │
│      → Agent assigned                                                    │
│      → Agent loads workflow (!)                                          │
│                          │                           │                   │
│                          │                           │                   │
│  ┌───────────────────────┴───────────────────────────┴──────────────┐    │
│  │  ⚠️  RACE CONDITION: Agent may load workflow BEFORE webhook!     │    │
│  │      Solution: SSE push when webhook arrives + loading indicator │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                          │                           │                   │
│                          ▼                           ▼                   │
│  4a. Agent Desktop shows:             4b. Webhook arrives:               │
│      - "Loading AI data..." badge          call.conversation_insights    │
│      - Workflow in pending state           .generated                    │
│      - Can still interact manually         {                             │
│                          │                   call_control_id: "...",     │
│                          │                   insight_group_id: "...",    │
│                          │                   results: [                  │
│                          │                     {                         │
│                          │                       insight_id: "slots_id", │
│                          │                       result: {               │
│                          │                         slots: {              │
│                          │                           customer_name: {    │
│                          │                             value: "Jan K.",  │
│                          │                             confidence: 0.95  │
│                          │                           },                  │
│                          │                           issue_type: {...}   │
│                          │                         },                    │
│                          │                         completed_stages: []  │
│                          │                       }                       │
│                          │                     },                        │
│                          │                     {                         │
│                          │                       insight_id: "summ_id",  │
│                          │                       result: "## Summary..." │
│                          │                     },                        │
│                          │                     {                         │
│                          │                       insight_id: "sent_id",  │
│                          │                       result: "## Sentiment.."│
│                          │                     }                         │
│                          │                   ]                           │
│                          │                 }                             │
│                          │                           │                   │
│                          │                           ▼                   │
│                          │             5. Webhook handler:               │
│                          │                a) Find interaction by         │
│                          │                   call_session_id/call_leg_id │
│                          │                b) Store raw data in           │
│                          │                   aa_ai_handoff_events        │
│                          │                c) If workflow session exists: │
│                          │                   - Update slots_filled       │
│                          │                   - Update item statuses      │
│                          │                   - Store summary/sentiment   │
│                          │                d) Broadcast via SSE           │
│                          │                           │                   │
│                          └─────────────┬─────────────┘                   │
│                                        │                                 │
│                                        ▼                                 │
│  6. Agent Desktop receives SSE event: "ai_handoff_data"                  │
│     → Loading indicator disappears                                       │
│     → Workflow updates with completed slots (animation)                  │
│     → AI Summary panel populated                                         │
│     → Sentiment indicator shown                                          │
│     → Toast: "AI data received - 3 slots pre-filled"                     │
│                                        │                                 │
│                                        ▼                                 │
│  7. Agent continues conversation from AI handoff point                   │
│     → Sees which data already collected                                  │
│     → Suggested responses skip completed items                           │
│     → Can review/edit AI-collected values                                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Handling the Race Condition

**Problem**: Webhook może dotrzeć 2-10+ sekund po transferze. Agent może już rozmawiać z klientem zanim dane z AI dotrą.

**Solution: Multi-layer approach**

```
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Immediate (przy starcie workflow session)                     │
├────────────────────────────────────────────────────────────────────────┤
│ • Check if aa_ai_handoff_events already has data for this interaction  │
│ • If yes → pre-populate immediately                                    │
│ • If no → show "Waiting for AI data..." indicator                      │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 2: Real-time (SSE push)                                          │
├────────────────────────────────────────────────────────────────────────┤
│ • Agent Desktop subscribes to SSE for interaction updates              │
│ • Webhook handler broadcasts "ai_handoff_data" event                   │
│ • Desktop receives → updates UI in real-time                           │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 3: Fallback polling (if SSE missed)                              │
├────────────────────────────────────────────────────────────────────────┤
│ • If interaction has ai_call_control_id AND no AI data after 5 sec    │
│ • Poll /api/agent-assist/workflow/ai-context every 3 sec              │
│ • Max 10 attempts (30 sec total)                                       │
│ • After timeout: hide loading indicator, agent continues manually      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema Changes

### 1. New Columns in `aa_workflows`

```sql
-- Store Telnyx Insight IDs for the 3 standard insights
ALTER TABLE aa_workflows 
ADD COLUMN IF NOT EXISTS insight_group_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS insight_slots_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS insight_summary_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS insight_sentiment_id VARCHAR(255);

-- Index for lookup by group
CREATE INDEX IF NOT EXISTS idx_aa_workflows_insight_group_id 
ON aa_workflows (insight_group_id) 
WHERE insight_group_id IS NOT NULL;
```

### 2. New Columns in `aa_workflow_sessions`

```sql
-- Store AI handoff data
ALTER TABLE aa_workflow_sessions
ADD COLUMN IF NOT EXISTS ai_summary TEXT,
ADD COLUMN IF NOT EXISTS ai_sentiment TEXT,
ADD COLUMN IF NOT EXISTS ai_handoff_received_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS ai_handoff_source VARCHAR(20); -- 'webhook' | 'polling' | 'manual'
```

### 3. New Table: `aa_ai_handoff_events`

```sql
CREATE TABLE IF NOT EXISTS aa_ai_handoff_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id UUID REFERENCES cc_interactions(id) ON DELETE CASCADE,
  workflow_session_id UUID REFERENCES aa_workflow_sessions(id) ON DELETE SET NULL,
  ai_call_control_id VARCHAR(255),
  insight_group_id VARCHAR(255),
  raw_payload JSONB,
  processed_slots JSONB,
  status VARCHAR(20) DEFAULT 'pending', -- pending, processed, failed
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_aa_ai_handoff_events_interaction_id 
ON aa_ai_handoff_events (interaction_id);

CREATE INDEX IF NOT EXISTS idx_aa_ai_handoff_events_ai_call_control_id 
ON aa_ai_handoff_events (ai_call_control_id);
```

---

## API Endpoints

### New Endpoints

#### 1. `POST /api/webhooks/telnyx/conversation-insights`

Webhook endpoint dla Telnyx Insights. Receives all 3 insights in one webhook.

```javascript
// Request from Telnyx
{
  "record_type": "event",
  "event_type": "call.conversation_insights.generated",
  "payload": {
    "call_control_id": "v3:xxx",
    "call_session_id": "uuid",
    "call_leg_id": "uuid",
    "insight_group_id": "uuid",
    "results": [
      {
        "insight_id": "slots-insight-uuid", 
        "result": {
          "slots": {
            "customer_name": {
              "value": "Jan Kowalski",
              "confidence": 0.95,
              "source_utterance": "My name is Jan Kowalski"
            },
            "issue_type": {
              "value": "billing",
              "confidence": 0.85,
              "source_utterance": "I have a billing question"
            }
          },
          "completed_stages": ["Greeting", "Identification"]
        }
      },
      {
        "insight_id": "summary-insight-uuid",
        "result": "## Call Summary\n\n**Customer Goal:** Billing inquiry..."
      },
      {
        "insight_id": "sentiment-insight-uuid",
        "result": "## Sentiment Analysis\n\n**Overall:** Neutral (6/10)..."
      }
    ]
  }
}

// Response
{ "ok": true, "processed": true, "session_updated": true }
```

**Processing Logic:**
1. Find workflow by `insight_group_id`
2. Find interaction by `call_session_id` or `call_leg_id` (with `ai_call_control_id` match)
3. Store raw event in `aa_ai_handoff_events`
4. If workflow session exists:
   - Parse slots result → update `slots_filled` and `aa_workflow_item_status`
   - Store summary in `ai_summary`
   - Store sentiment in `ai_sentiment`
   - Calculate `current_stage_id` based on completed items
5. Broadcast SSE event to agent

#### 2. `POST /api/admin/workflows/[id]/sync-insights`

Synchronizacja Insight Group z workflow (ręczna lub automatyczna przy save).

```javascript
// Request (optional body)
{
  "force": false  // If true, recreate all insights even if exist
}

// Response
{
  "ok": true,
  "insight_group_id": "uuid",
  "insight_slots_id": "uuid",
  "insight_summary_id": "uuid", 
  "insight_sentiment_id": "uuid",
  "action": "created" | "updated" | "unchanged"
}
```

**Processing Logic:**
1. Check if workflow has `insight_group_id`
   - No → Create new Insight Group with webhook URL
   - Yes → Use existing group
2. For each insight type (slots, summary, sentiment):
   - Check if insight exists (by stored ID)
   - Create if missing, update if schema changed
3. Update `aa_workflows` with new insight IDs
4. If AI Assistant exists, update its `insight_settings.insight_group_id`

#### 3. `GET /api/agent-assist/workflow/ai-context?interactionId=xxx`

Pobierz kontekst z AI konwersacji (fallback jeśli webhook nie dotarł).

```javascript
// Response (when data available)
{
  "ok": true,
  "status": "available",
  "data": {
    "slots_filled": {
      "customer_name": "Jan Kowalski",
      "issue_type": "billing"
    },
    "summary": "## Call Summary...",
    "sentiment": "## Sentiment Analysis...",
    "received_at": "2025-02-12T11:30:00Z",
    "source": "webhook"
  }
}

// Response (when waiting)
{
  "ok": true,
  "status": "pending",
  "message": "Waiting for AI data...",
  "ai_call_control_id": "v3:xxx"
}

// Response (when not applicable)
{
  "ok": true,
  "status": "not_applicable",
  "message": "No AI assistant was involved in this call"
}
```

#### 4. `GET /api/agent-assist/workflow/ai-conversation?interactionId=xxx`

Pobierz pełną historię konwersacji z AI (opcjonalnie, dla debugowania/review).

```javascript
// Response
{
  "ok": true,
  "conversation_id": "uuid",
  "messages": [
    { "role": "assistant", "content": "Hello, how can I help?", "timestamp": "..." },
    { "role": "user", "content": "I have a billing question", "timestamp": "..." },
    ...
  ],
  "duration_seconds": 127
}
```

### Modified Endpoints

#### `POST /api/admin/workflows` (Create)

Dodać tworzenie Insight Group przy tworzeniu workflow z AI assistant.

#### `PUT /api/admin/workflows/[id]` (Update)

Dodać sync insights przy update workflow.

#### `POST /api/admin/workflows/[id]/update-assistant`

Rozszerzyć o update `insight_settings` na assistantcie.

#### `DELETE /api/admin/workflows/[id]`

Dodać cleanup Insight Group przy usuwaniu workflow.

---

## Implementation Components

### 1. `lib/telnyx-insights.js`

```javascript
/**
 * Telnyx Insights API wrapper
 */

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

// ============ INSIGHT GROUPS ============

// Create Insight Group for workflow
export async function createInsightGroup(workflowName, webhookUrl) {
  // POST /ai/conversations/insight-groups
  // Returns: { id, name, webhook, ... }
}

// Update Insight Group (e.g., change webhook URL)
export async function updateInsightGroup(groupId, updates) {
  // PUT /ai/conversations/insight-groups/{group_id}
}

// Delete Insight Group (when workflow deleted)
export async function deleteInsightGroup(groupId) {
  // DELETE /ai/conversations/insight-groups/{group_id}
}

// ============ INSIGHT TEMPLATES ============

// Create Insight Template
export async function createInsight({ name, instructions, jsonSchema, webhook }) {
  // POST /ai/conversations/insights
  // Returns: { id, name, instructions, json_schema, ... }
}

// Update Insight Template
export async function updateInsight(insightId, updates) {
  // PUT /ai/conversations/insights/{insight_id}
}

// Delete Insight Template
export async function deleteInsight(insightId) {
  // DELETE /ai/conversations/insights/{insight_id}
}

// ============ GROUP ASSIGNMENTS ============

// Assign insight to group
export async function assignInsightToGroup(insightId, groupId) {
  // POST /ai/conversations/insight-groups/{group_id}/insights/{insight_id}/assign
}

// Unassign insight from group
export async function unassignInsightFromGroup(insightId, groupId) {
  // POST /ai/conversations/insight-groups/{group_id}/insights/{insight_id}/unassign
}

// ============ HIGH-LEVEL OPERATIONS ============

/**
 * Create or update all 3 insights for a workflow
 * @param {Object} workflow - Workflow with stages and items
 * @param {string} webhookUrl - URL for insights webhook
 * @returns {Object} { groupId, slotsInsightId, summaryInsightId, sentimentInsightId }
 */
export async function syncWorkflowInsights(workflow, webhookUrl) {
  // 1. Create/get insight group
  let groupId = workflow.insight_group_id;
  if (!groupId) {
    const group = await createInsightGroup(`WF: ${workflow.name}`, webhookUrl);
    groupId = group.id;
  }
  
  // 2. Generate schemas and instructions
  const slotsSchema = generateSlotsSchema(workflow.slots);
  const slotsInstructions = generateSlotsInstructions(workflow, workflow.stages);
  const summaryInstructions = generateSummaryInstructions(workflow);
  const sentimentInstructions = generateSentimentInstructions(workflow);
  
  // 3. Create/update each insight
  const slotsInsight = await upsertInsight(workflow.insight_slots_id, {
    name: `${workflow.name} - Slots`,
    instructions: slotsInstructions,
    jsonSchema: slotsSchema
  });
  
  const summaryInsight = await upsertInsight(workflow.insight_summary_id, {
    name: `${workflow.name} - Summary`,
    instructions: summaryInstructions
  });
  
  const sentimentInsight = await upsertInsight(workflow.insight_sentiment_id, {
    name: `${workflow.name} - Sentiment`,
    instructions: sentimentInstructions
  });
  
  // 4. Ensure all are assigned to group
  await ensureInsightInGroup(slotsInsight.id, groupId);
  await ensureInsightInGroup(summaryInsight.id, groupId);
  await ensureInsightInGroup(sentimentInsight.id, groupId);
  
  return {
    groupId,
    slotsInsightId: slotsInsight.id,
    summaryInsightId: summaryInsight.id,
    sentimentInsightId: sentimentInsight.id
  };
}

/**
 * Get insights for a conversation (polling fallback)
 */
export async function getConversationInsights(conversationId) {
  // GET /ai/conversations/{conversation_id}/conversations-insights
}

/**
 * Clean up insights when workflow is deleted
 */
export async function deleteWorkflowInsights(workflow) {
  if (workflow.insight_slots_id) await deleteInsight(workflow.insight_slots_id);
  if (workflow.insight_summary_id) await deleteInsight(workflow.insight_summary_id);
  if (workflow.insight_sentiment_id) await deleteInsight(workflow.insight_sentiment_id);
  if (workflow.insight_group_id) await deleteInsightGroup(workflow.insight_group_id);
}
```

### 2. `lib/agent-assist/ai-handoff-processor.js`

```javascript
/**
 * Process AI handoff webhook events
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { broadcastToKey } from "@/lib/sse";

/**
 * Main webhook processor
 * Called by POST /api/webhooks/telnyx/conversation-insights
 */
export async function processInsightsWebhook(payload) {
  const pool = getPostgresPool();
  
  // 1. Extract key identifiers
  const { call_control_id, call_session_id, call_leg_id, insight_group_id, results } = payload;
  
  // 2. Find workflow by insight_group_id
  const workflow = await findWorkflowByInsightGroup(insight_group_id);
  if (!workflow) {
    console.warn(`[AI Handoff] No workflow found for insight_group_id: ${insight_group_id}`);
    return { processed: false, reason: 'workflow_not_found' };
  }
  
  // 3. Find interaction (may not exist yet if webhook arrived before call.initiated)
  const interaction = await findInteractionForAiHandoff({
    callSessionId: call_session_id,
    callLegId: call_leg_id,
    aiCallControlId: call_control_id
  });
  
  // 4. Store raw event for auditing/retry
  const eventId = await storeHandoffEvent({
    interactionId: interaction?.id,
    aiCallControlId: call_control_id,
    insightGroupId: insight_group_id,
    rawPayload: payload,
    status: interaction ? 'processing' : 'pending_interaction'
  });
  
  if (!interaction) {
    console.log(`[AI Handoff] Interaction not found yet, stored for later processing`);
    return { processed: false, eventId, reason: 'interaction_pending' };
  }
  
  // 5. Parse results by insight type
  const parsedData = parseInsightResults(results, workflow);
  
  // 6. Find or note workflow session
  const session = await findWorkflowSessionByInteraction(interaction.id);
  
  if (session) {
    // 7a. Update existing session with AI data
    await updateWorkflowSession(session.id, parsedData);
    await markEventProcessed(eventId, session.id);
    
    // 8. Broadcast to agent
    await broadcastAiHandoffData(interaction, session.id, parsedData);
    
    return { processed: true, sessionUpdated: true, sessionId: session.id };
  } else {
    // 7b. Session doesn't exist yet - data will be applied when session starts
    await markEventReadyForSession(eventId, interaction.id);
    
    return { processed: true, sessionUpdated: false, pendingForSession: true };
  }
}

/**
 * Parse the 3 insight results into structured data
 */
function parseInsightResults(results, workflow) {
  const data = {
    slots: {},
    completedStages: [],
    summary: null,
    sentiment: null
  };
  
  for (const result of results) {
    if (result.insight_id === workflow.insight_slots_id) {
      // Slots insight - structured JSON
      const parsed = typeof result.result === 'string' 
        ? JSON.parse(result.result) 
        : result.result;
      data.slots = parsed.slots || {};
      data.completedStages = parsed.completed_stages || [];
    } else if (result.insight_id === workflow.insight_summary_id) {
      // Summary insight - markdown text
      data.summary = result.result;
    } else if (result.insight_id === workflow.insight_sentiment_id) {
      // Sentiment insight - markdown text
      data.sentiment = result.result;
    }
  }
  
  return data;
}

/**
 * Update workflow session with AI-collected data
 */
async function updateWorkflowSession(sessionId, data) {
  const pool = getPostgresPool();
  
  // 1. Update session with summary, sentiment, slots
  await pool.query(`
    UPDATE aa_workflow_sessions SET
      slots_filled = slots_filled || $1::jsonb,
      ai_summary = $2,
      ai_sentiment = $3,
      ai_handoff_received_at = NOW(),
      ai_handoff_source = 'webhook',
      updated_at = NOW()
    WHERE id = $4
  `, [JSON.stringify(data.slots), data.summary, data.sentiment, sessionId]);
  
  // 2. Update item statuses for filled slots
  const session = await getWorkflowSessionState(sessionId);
  
  for (const [slotName, slotData] of Object.entries(data.slots)) {
    if (slotData?.value !== null && slotData?.confidence >= 0.7) {
      // Find item with this slot_name and mark completed
      const item = session.stages
        .flatMap(s => s.items)
        .find(i => i.slot_name === slotName);
      
      if (item) {
        await pool.query(`
          UPDATE aa_workflow_item_status SET
            status = 'completed',
            extracted_value = $1,
            confidence = $2,
            completed_at = NOW(),
            completed_by = 'ai'
          WHERE session_id = $3 AND item_id = $4
        `, [slotData.value, slotData.confidence, sessionId, item.id]);
      }
    }
  }
  
  // 3. Calculate and update current stage
  await recalculateCurrentStage(sessionId);
}

/**
 * Broadcast AI handoff data to agent via SSE
 */
async function broadcastAiHandoffData(interaction, sessionId, data) {
  if (!interaction.agent_username) return;
  
  const { PgDb } = await import("@/lib/pgdb.js");
  const agent = await PgDb.findUserByUsername(interaction.agent_username);
  if (!agent?.id) return;
  
  broadcastToKey(`user:status:${agent.id}`, {
    type: 'ai_handoff_data',
    interactionId: interaction.id,
    sessionId,
    data: {
      slots_filled: data.slots,
      summary: data.summary,
      sentiment: data.sentiment,
      received_at: new Date().toISOString()
    }
  });
}

/**
 * Check for pending AI data when starting a new workflow session
 * Called by POST /api/agent-assist/workflow/start
 */
export async function applyPendingAiHandoff(interactionId, sessionId) {
  const pool = getPostgresPool();
  
  // Find pending event for this interaction
  const { rows: [event] } = await pool.query(`
    SELECT * FROM aa_ai_handoff_events 
    WHERE interaction_id = $1 AND status = 'pending_session'
    ORDER BY created_at DESC LIMIT 1
  `, [interactionId]);
  
  if (!event) return null;
  
  // Process the stored payload
  const workflow = await findWorkflowByInsightGroup(event.insight_group_id);
  const parsedData = parseInsightResults(event.raw_payload.results, workflow);
  
  await updateWorkflowSession(sessionId, parsedData);
  await markEventProcessed(event.id, sessionId);
  
  return parsedData;
}
```

### 3. `lib/agent-assist/insight-schema-generator.js`

```javascript
/**
 * Generate insight configurations for workflow
 */

// Generate combined JSON schema for all workflow slots
export function generateSlotsSchema(workflowSlots) {
  const slotProperties = {};
  
  for (const slot of workflowSlots) {
    slotProperties[slot.slot_name] = {
      type: "object",
      properties: {
        value: getValueSchemaForType(slot.slot_type),
        confidence: { 
          type: "number", 
          minimum: 0, 
          maximum: 1,
          description: "Confidence score 0-1, null if not found"
        },
        source_utterance: { 
          type: "string",
          description: "Exact quote from conversation where value was mentioned"
        }
      },
      description: slot.description || slot.label
    };
  }
  
  return {
    type: "object",
    properties: {
      slots: {
        type: "object",
        properties: slotProperties,
        description: "Extracted slot values from the conversation"
      },
      completed_stages: {
        type: "array",
        items: { type: "string" },
        description: "List of stage names that were fully completed"
      }
    },
    required: ["slots"]
  };
}

// Generate instructions for slots extraction insight
export function generateSlotsInstructions(workflow, stages) {
  let instructions = `Analyze the conversation and extract the following information for a ${workflow.name} workflow.\n\n`;
  instructions += `## Slots to Extract\n\n`;
  
  for (const stage of stages) {
    instructions += `### ${stage.name}\n`;
    for (const item of stage.items || []) {
      if (item.type === 'slot' && item.slot_name) {
        instructions += `- **${item.slot_name}** (${item.slot_type || 'text'}): ${item.label}`;
        if (item.description) instructions += ` - ${item.description}`;
        if (item.hints?.length) instructions += `\n  Hints: ${item.hints.join(', ')}`;
        instructions += `\n`;
      }
    }
  }
  
  instructions += `\n## Instructions\n`;
  instructions += `- For each slot, extract the value if clearly stated in conversation\n`;
  instructions += `- Set value to null if information was not provided or unclear\n`;
  instructions += `- Confidence: 1.0 = explicitly stated, 0.7-0.9 = inferred, <0.7 = uncertain\n`;
  instructions += `- Include the exact source utterance where the value was mentioned\n`;
  instructions += `- List completed_stages only if ALL items in that stage were addressed\n`;
  
  return instructions;
}

// Instructions for call summary insight
export function generateSummaryInstructions(workflow) {
  return `Provide a concise summary of this ${workflow.name} conversation for a contact center agent who will continue the call.

## Requirements
- Use **Markdown formatting** for better readability
- Focus on actionable information the agent needs to know
- Highlight any commitments made or issues raised
- Note the customer's primary concern and current emotional state
- Keep it under 200 words

## Format
\`\`\`markdown
## Call Summary

**Customer Goal:** [Main reason for calling]

**Key Points:**
- [Important point 1]
- [Important point 2]

**Action Items:**
- [What needs to happen next]

**Notes:** [Any other relevant context]
\`\`\``;
}

// Instructions for sentiment analysis insight
export function generateSentimentInstructions(workflow) {
  return `Analyze the customer's sentiment throughout this ${workflow.name} conversation.

## Requirements
- Use **Markdown formatting** for the output
- Track sentiment changes during the conversation
- Identify trigger points (what made them happy/frustrated)
- Provide actionable advice for the agent

## Format
\`\`\`markdown
## Sentiment Analysis

**Overall Sentiment:** [Positive/Neutral/Negative] (score: X/10)

**Sentiment Timeline:**
1. 🟢 Start: [Initial mood]
2. 🟡 Middle: [Any changes and why]
3. 🔴/🟢 End: [Final state before transfer]

**Trigger Points:**
- 👍 Positive: [What made them happy]
- 👎 Negative: [What frustrated them]

**Agent Tips:**
- [How to approach this customer]
- [Topics to avoid/emphasize]
\`\`\``;
}
```

---

## Workflow Editor UI Changes

### 1. AI Assistant Section Enhancement

W workflow editor dodać sekcję pokazującą:
- Status insight sync (synced/out-of-date)
- Lista slotów z ich insight IDs
- Przycisk "Sync Insights" (manual trigger)
- Checkbox "Auto-sync insights on save"

### 2. Slot Item Editor Enhancement

Dla itemów typu `slot` dodać:
- Preview generated JSON schema
- Preview extraction instructions
- Test extraction (dry run z sample conversation)

---

## Agent Desktop UI Changes

### 1. AI Handoff Indicator

Gdy interaction ma `ai_call_control_id`:
- Pokazać badge "AI Assisted"
- Pokazać przycisk "View AI Conversation"
- Timeline z wydarzeniami AI conversation

### 2. Pre-filled Workflow State

- Wypełnione sloty oznaczone jako "AI Collected"
- Możliwość edycji/korekty wartości przez agenta
- Completed stages zaznaczone wizualnie
- Current stage highlighted

### 3. Real-time Updates

- SSE listener dla workflow state updates
- Animacja przy otrzymaniu danych z AI
- Toast notification "AI data received"

---

## Edge Cases & Error Handling

### 1. Timing Issues (CRITICAL)

**Problem**: Webhook może dotrzeć 2-10+ sekund po transferze. Agent może już:
- Mieć załadowany workflow session
- Być w trakcie rozmowy z klientem
- Ręcznie wypełniać sloty

**Rozwiązanie - Multi-layer Approach**:

```
Timeline:
─────────────────────────────────────────────────────────────────────────
T+0s    AI transfer initiated
T+1s    Call arrives at CC, interaction created
T+2s    Agent assigned, picks up call
T+3s    Agent opens workflow (session started)
T+5s    Agent starts collecting data manually
T+8s    ⚡ WEBHOOK ARRIVES - AI data received
T+8s    SSE pushed to agent → UI updates with AI data
─────────────────────────────────────────────────────────────────────────
```

| Scenario | Detection | Action |
|----------|-----------|--------|
| Webhook before session | `session_id = null` | Store in `aa_ai_handoff_events` with `status='pending_session'` |
| Webhook after session | `session_id` found | Update session immediately, broadcast SSE |
| Session starts, pending data exists | Check `aa_ai_handoff_events` | Apply stored data on session start |
| Webhook never arrives | Timeout 30s | Fallback to API polling, then give up |

**Agent Desktop Behavior**:
- If `ai_call_control_id` present → show "⏳ Loading AI data..." badge
- When data arrives → animate slot fills, show toast
- If timeout → hide badge, agent continues manually
- AI-filled slots show "🤖" indicator, manually-filled show "👤"

### 2. Missing/Low Confidence Slots

**Problem**: AI może nie zebrać wszystkich slotów lub mieć niską pewność.

**Rozwiązanie**:
- `confidence >= 0.7` → auto-complete slot, mark as "AI Collected"
- `confidence 0.5-0.7` → show value but mark as "⚠️ Needs Verification"
- `confidence < 0.5` or `null` → leave slot empty, agent fills manually

```javascript
// Slot status based on AI confidence
const getSlotStatus = (slotData) => {
  if (!slotData?.value) return 'empty';
  if (slotData.confidence >= 0.7) return 'ai_completed';
  if (slotData.confidence >= 0.5) return 'ai_needs_verification';
  return 'ai_low_confidence';
};
```

### 3. Webhook Delivery Failure

**Problem**: Webhook może nie dotrzeć (network issues, 5xx errors).

**Rozwiązanie**:
- Telnyx ma retry mechanism (3 attempts)
- Our endpoint must be idempotent (check by `call_control_id`)
- Fallback polling jeśli brak danych po 30s:
  1. Get `ai_call_control_id` from interaction
  2. Find conversation by call_control_id
  3. Fetch insights via `GET /ai/conversations/{id}/conversations-insights`
  4. Process same as webhook

```javascript
// Polling fallback in agent-assist/ai-context endpoint
if (interaction.ai_call_control_id && !hasAiData) {
  const insights = await pollForInsights(interaction.ai_call_control_id, {
    maxAttempts: 10,
    intervalMs: 3000,
    timeoutMs: 30000
  });
  if (insights) {
    await processInsightsData(interaction.id, insights);
  }
}
```

### 4. Concurrent Edits

**Problem**: Agent edytuje slot ręcznie w tym samym momencie gdy przybywa AI data.

**Rozwiązanie**:
- AI data NEVER overwrites agent-entered data
- Check `completed_by` field before updating
- If `completed_by = 'agent'`, skip AI update for that slot
- Show conflict indicator if values differ

```sql
-- Only update if not already completed by agent
UPDATE aa_workflow_item_status SET
  status = 'completed',
  extracted_value = $1,
  completed_by = 'ai'
WHERE session_id = $2 AND item_id = $3 
  AND (completed_by IS NULL OR completed_by = 'ai');
```

### 5. Multiple Transfers

**Problem**: Klient transferowany: AI → Agent1 → Agent2

**Rozwiązanie**:
- First AI handoff populates data
- Subsequent transfers preserve existing session
- New agent sees same workflow state
- Log all transfers in timeline

### 6. Workflow Changed After AI Assistant Created

**Problem**: Admin edits workflow slots after AI assistant was created.

**Rozwiązanie**:
- On workflow save → trigger `syncWorkflowInsights()`
- Update `workflow_slots` insight with new JSON schema
- Existing conversations keep old schema (insights are per-conversation)
- New conversations use updated schema

### 7. Insight Group Deleted Externally

**Problem**: Someone deletes insight group from Telnyx Portal.

**Rozwiązanie**:
- On next workflow save, detect 404 from API
- Clear `insight_group_id` and insight IDs
- Recreate insight group from scratch
- Log warning for admin

### 8. Large Workflow (Many Slots)

**Problem**: Workflow z 20+ slotami może mieć duży JSON schema.

**Rozwiązanie**:
- JSON schema size limit: ~64KB (Telnyx limit TBD)
- If exceeded, split into logical groups or simplify
- Monitor schema size on sync
- Warn admin if approaching limit

---

## Security Considerations

### 1. Webhook Authentication

- Telnyx podpisuje webhooki - weryfikować signature
- Użyć istniejącej `verifyTelnyxSignature()` funkcji
- Reject unsigned requests

### 2. Data Validation

- Validate insight results match expected schema
- Sanitize extracted values before storing
- Rate limit webhook endpoint

### 3. Access Control

- Tylko authorized users mogą sync insights
- Webhook endpoint nie wymaga auth (ale wymaga signature)
- API endpoints dla AI context wymagają session auth

---

## Testing Strategy

### 1. Unit Tests

- Schema generation dla różnych slot types
- Insight mapping logic
- Stage calculation algorithm

### 2. Integration Tests

- Webhook processing end-to-end
- Insight CRUD operations
- Workflow session updates

### 3. Manual Testing Scenarios

1. **Happy Path**: AI zbiera wszystkie dane → transfer → agent widzi wypełniony workflow
2. **Partial Data**: AI zbiera część danych → transfer → agent kontynuuje od środka
3. **No AI Data**: Direct call (no AI) → agent widzi pusty workflow
4. **Late Webhook**: Session started before webhook → dane dołączają
5. **Failed Webhook**: Polling fallback works

---

## Implementation Phases

### Phase 1: Database & Core Infrastructure (Day 1-2)

1. Schema migrations (nowe kolumny, tabela handoff events)
2. `lib/telnyx-insights.js` - API wrapper
3. `lib/agent-assist/insight-schema-generator.js`
4. Webhook endpoint (basic)

### Phase 2: Workflow Integration (Day 3-4)

1. Modify workflow create/update to sync insights
2. `lib/agent-assist/ai-handoff-processor.js`
3. Webhook processing logic
4. Fallback polling mechanism

### Phase 3: Agent Desktop UI (Day 5-6)

1. AI handoff indicators
2. Pre-filled workflow display
3. Real-time SSE updates
4. AI conversation viewer

### Phase 4: Testing & Polish (Day 7)

1. End-to-end testing
2. Error handling improvements
3. Documentation
4. Performance optimization

---

## Open Questions

1. ~~**Insight Webhook Timing**: Czy webhook jest wysyłany przy transfer czy przy hangup?~~
   ✅ **ANSWERED**: Webhook wysyłany zaraz po transfer lub hangup - może być opóźniony 2-10+ sekund. Rozwiązane przez multi-layer approach (SSE + polling).

2. **Insight Group Limits**: Czy są limity na liczbę insights per group? (sprawdzić API limits)
   → Przy 3 insights per workflow nie powinno być problemu, ale warto zweryfikować.

3. **Insight Update vs Recreate**: Przy update workflow z innymi slotami:
   - **Option A**: Update `workflow_slots` insight z nowym schema (zachowuje insight_id)
   - **Option B**: Delete + recreate (prostsze, nowy insight_id)
   → Rekomendacja: Option A jeśli API pozwala, Option B jako fallback

4. **Multi-language Support**: Czy instructions dla insights powinny być w języku workflow?
   → Rekomendacja: Instructions po angielsku (LLM lepiej rozumie), ale `slot.label` i `slot.description` mogą być w języku workflow dla kontekstu.

5. **Confidence Threshold**: Jaki próg confidence dla auto-completion slotu?
   → Propozycja: ≥0.7 = auto-complete, <0.7 = show as "needs verification"

---

## References

- Telnyx AI Assistants API: `/ai/assistants`
- Telnyx Conversations Insights API: `/ai/conversations/insights`
- Telnyx Insight Groups API: `/ai/conversations/insight-groups`
- Webhook Event: `call.conversation_insights.generated`
- Existing code: `lib/agent-assist/workflow-*.js`

---

## Appendix A: Combined Slots Schema Example

Example for a "Customer Support" workflow with 4 slots:

```json
{
  "type": "object",
  "properties": {
    "slots": {
      "type": "object",
      "properties": {
        "customer_name": {
          "type": "object",
          "properties": {
            "value": { "type": "string" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "source_utterance": { "type": "string" }
          },
          "description": "Customer's full name"
        },
        "account_number": {
          "type": "object",
          "properties": {
            "value": { "type": "string", "pattern": "^[A-Z]{2}[0-9]{8}$" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "source_utterance": { "type": "string" }
          },
          "description": "Account number (format: XX12345678)"
        },
        "issue_category": {
          "type": "object",
          "properties": {
            "value": { 
              "type": "string",
              "enum": ["billing", "technical", "account", "sales", "other"]
            },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "source_utterance": { "type": "string" }
          },
          "description": "Category of the customer's issue"
        },
        "callback_requested": {
          "type": "object",
          "properties": {
            "value": { "type": "boolean" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "source_utterance": { "type": "string" }
          },
          "description": "Whether customer requested a callback"
        }
      }
    },
    "completed_stages": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Names of stages where all items were addressed"
    }
  },
  "required": ["slots"]
}
```

### Example Webhook Response (workflow_slots insight)

```json
{
  "insight_id": "550e8400-e29b-41d4-a716-446655440001",
  "result": {
    "slots": {
      "customer_name": {
        "value": "Jan Kowalski",
        "confidence": 0.98,
        "source_utterance": "My name is Jan Kowalski"
      },
      "account_number": {
        "value": "PL12345678",
        "confidence": 0.95,
        "source_utterance": "The account number is PL12345678"
      },
      "issue_category": {
        "value": "billing",
        "confidence": 0.85,
        "source_utterance": "I have a question about my last invoice"
      },
      "callback_requested": {
        "value": null,
        "confidence": null,
        "source_utterance": null
      }
    },
    "completed_stages": ["Greeting", "Identification"]
  }
}
```

---

## Appendix B: Slot Type Value Schemas

Reference for `getValueSchemaForType(slot_type)` function:

| slot_type | JSON Schema |
|-----------|-------------|
| `text` | `{ "type": "string" }` |
| `email` | `{ "type": "string", "format": "email" }` |
| `phone` | `{ "type": "string", "pattern": "^\\+?[0-9\\s\\-()]+$" }` |
| `number` | `{ "type": "number" }` |
| `integer` | `{ "type": "integer" }` |
| `boolean` | `{ "type": "boolean" }` |
| `date` | `{ "type": "string", "format": "date" }` |
| `datetime` | `{ "type": "string", "format": "date-time" }` |
| `enum` | `{ "type": "string", "enum": [...values from hints] }` |
| `currency` | `{ "type": "number" }` |

---

## Appendix C: Example Insight Outputs

### Call Summary (markdown output)

```markdown
## Call Summary

**Customer Goal:** Resolve billing discrepancy on January invoice

**Key Points:**
- Customer noticed €45 charge they don't recognize
- Account verified: PL12345678 (Jan Kowalski)
- Customer was initially frustrated but calmed after explanation started
- AI assistant explained it might be a subscription renewal

**Action Items:**
- Verify the €45 charge in billing system
- Consider refund if charge was unauthorized
- Update customer preferences if needed

**Notes:** Customer mentioned they're a 5-year subscriber and expects good service.
```

### Sentiment Analysis (markdown output)

```markdown
## Sentiment Analysis

**Overall Sentiment:** Neutral → Slightly Positive (score: 6/10)

**Sentiment Timeline:**
1. 🔴 Start: Frustrated - "I don't understand this charge"
2. 🟡 Middle: Calming - AI explained subscription renewal possibility
3. 🟢 End: Hopeful - "Okay, I hope the agent can sort this out"

**Trigger Points:**
- 👎 Negative: Unexpected charge, waiting time
- 👍 Positive: AI's clear explanation, offer to transfer to human

**Agent Tips:**
- Acknowledge their frustration first
- Be prepared to explain or refund the €45 charge
- Mention their loyalty (5-year customer) - they value recognition
```

---

## Appendix D: SSE Event Payloads

### Event: `ai_handoff_data`

Sent when webhook is processed:

```json
{
  "type": "ai_handoff_data",
  "interactionId": "uuid",
  "sessionId": "workflow-session-uuid",
  "data": {
    "slots_filled": {
      "customer_name": "Jan Kowalski",
      "account_number": "PL12345678",
      "issue_category": "billing"
    },
    "items_completed": ["item-uuid-1", "item-uuid-2", "item-uuid-3"],
    "current_stage_index": 2,
    "summary": "## Call Summary\n\n**Customer Goal:**...",
    "sentiment": "## Sentiment Analysis\n\n**Overall:**...",
    "received_at": "2025-02-12T11:30:00Z"
  }
}
```

### Event: `ai_handoff_pending`

Sent when interaction starts with AI call ID (before webhook arrives):

```json
{
  "type": "ai_handoff_pending",
  "interactionId": "uuid",
  "aiCallControlId": "v3:xxx",
  "message": "Waiting for AI conversation data..."
}
```

---

*Document Version: 1.1*
*Created: 2025-02-12*
*Updated: 2025-02-12 - Changed to 3-insight approach (slots/summary/sentiment)*
*Author: Vislabot + Leszek*
