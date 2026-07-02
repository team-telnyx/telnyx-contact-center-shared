# Agent Assist Workflow Module - Implementation Plan

## Overview

This document outlines the implementation plan for a **universal Agent Assist Workflow module** that guides human agents through structured conversation flows while providing real-time slot filling, intent detection, and sentiment analysis.

**Key Principle**: The module is industry-agnostic and can be configured for any use case (sales, support, healthcare, collections, surveys, etc.).

---

## 1. Data Model

### 1.1 Workflow Definition Schema

```sql
-- Workflow templates table
CREATE TABLE aa_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100), -- e.g., "sales", "support", "healthcare"
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Workflow stages (ordered steps)
CREATE TABLE aa_workflow_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID REFERENCES aa_workflows(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL, -- e.g., "Call Opening", "Verification", "Resolution"
  description TEXT,
  order_index INTEGER NOT NULL,
  is_required BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Stage items (actions/questions/topics within a stage)
CREATE TABLE aa_workflow_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id UUID REFERENCES aa_workflow_stages(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- "action", "question", "topic", "slot"
  label VARCHAR(500) NOT NULL, -- Display text, e.g., "Thank you for calling..."
  description TEXT, -- Additional context for the agent
  prompt_hint TEXT, -- LLM hint for detection (keywords, phrases)
  order_index INTEGER NOT NULL,
  is_required BOOLEAN DEFAULT true,
  
  -- For slot-type items
  slot_name VARCHAR(100), -- e.g., "customer_name", "account_number"
  slot_type VARCHAR(50), -- "text", "number", "date", "email", "phone", "boolean", "enum"
  slot_options JSONB, -- For enum type: ["option1", "option2"]
  slot_validation TEXT, -- Regex or validation rule
  
  created_at TIMESTAMP DEFAULT NOW()
);

-- Active workflow sessions (per interaction)
CREATE TABLE aa_workflow_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id UUID REFERENCES cc_interactions(id) ON DELETE CASCADE,
  workflow_id UUID REFERENCES aa_workflows(id),
  current_stage_id UUID REFERENCES aa_workflow_stages(id),
  status VARCHAR(50) DEFAULT 'in_progress', -- "in_progress", "completed", "abandoned"
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  
  -- Aggregated data
  slots_filled JSONB DEFAULT '{}', -- {"customer_name": "John Doe", "account_number": "12345"}
  completion_percentage INTEGER DEFAULT 0,
  
  UNIQUE(interaction_id)
);

-- Item completion tracking
CREATE TABLE aa_workflow_item_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES aa_workflow_sessions(id) ON DELETE CASCADE,
  item_id UUID REFERENCES aa_workflow_items(id),
  status VARCHAR(50) DEFAULT 'pending', -- "pending", "completed", "skipped"
  completed_at TIMESTAMP,
  completed_by VARCHAR(50), -- "agent", "customer", "auto"
  extracted_value TEXT, -- For slots: the captured value
  confidence_score FLOAT, -- LLM confidence (0-1)
  source_transcript TEXT, -- The transcript that triggered completion
  
  UNIQUE(session_id, item_id)
);
```

### 1.2 Example Workflow Definition (JSON for API/Import)

```json
{
  "name": "Customer Support Call",
  "category": "support",
  "stages": [
    {
      "name": "Call Opening",
      "order": 1,
      "items": [
        {
          "type": "action",
          "label": "Thank you for calling...",
          "prompt_hint": "greeting, thank you for calling, welcome"
        },
        {
          "type": "action",
          "label": "Introduce yourself",
          "prompt_hint": "my name is, speaking with, this is"
        },
        {
          "type": "question",
          "label": "Is it okay if I verify account details?",
          "prompt_hint": "verify, confirm, account details, security"
        }
      ]
    },
    {
      "name": "Verification",
      "order": 2,
      "items": [
        {
          "type": "slot",
          "label": "Customer full name",
          "slot_name": "customer_name",
          "slot_type": "text",
          "prompt_hint": "name is, my name, speaking with"
        },
        {
          "type": "slot",
          "label": "Account number",
          "slot_name": "account_number",
          "slot_type": "text",
          "slot_validation": "^[0-9]{6,12}$",
          "prompt_hint": "account number, account is"
        },
        {
          "type": "slot",
          "label": "Date of birth",
          "slot_name": "dob",
          "slot_type": "date",
          "prompt_hint": "born, date of birth, birthday"
        }
      ]
    },
    {
      "name": "Resolution",
      "order": 3,
      "items": [
        {
          "type": "topic",
          "label": "Address customer inquiry",
          "prompt_hint": "issue, problem, question, help with"
        },
        {
          "type": "action",
          "label": "Provide solution or next steps",
          "prompt_hint": "solution, resolve, fix, next step"
        },
        {
          "type": "question",
          "label": "Is there anything else I can help with?",
          "prompt_hint": "anything else, other questions, further assistance"
        }
      ]
    }
  ]
}
```

---

## 2. Architecture

### 2.1 Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Desktop UI                             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              AgentAssistWorkflow Component               │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │    │
│  │  │ Stage Nav   │  │ Checklist   │  │ Slots Panel     │ │    │
│  │  │ (1/3, 2/3)  │  │ (items)     │  │ (filled values) │ │    │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘ │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Live Transcription Panel                    │    │
│  │  [Customer]: "Hi, my name is John and my account..."    │    │
│  │  [Agent]: "Thank you for calling, let me verify..."     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Workflow Engine (Server)                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ Session Manager │  │ LLM Analyzer    │  │ State Store     │ │
│  │ - Start/Stop    │  │ - Slot Extract  │  │ - Redis/Memory  │ │
│  │ - Progress      │  │ - Completion    │  │ - Persistence   │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Telnyx APIs                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ Streaming STT   │  │ AI Chat (GPT-4o)│  │ Voice API       │ │
│  │ Transcription   │  │ Analysis        │  │ Call Control    │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

1. **Call Starts** → Workflow session created, assigned to interaction
2. **Transcription Received** → Sent to LLM Analyzer
3. **LLM Analyzer** → Checks all pending items, extracts slots, detects intent/sentiment
4. **State Updated** → Item marked complete, slot value stored
5. **UI Updated** → Real-time via SSE/WebSocket, checklist updates

---

## 3. API Endpoints

### 3.1 Workflow Management (Admin)

```
GET    /api/admin/workflows              - List all workflows
POST   /api/admin/workflows              - Create workflow
GET    /api/admin/workflows/:id          - Get workflow with stages/items
PUT    /api/admin/workflows/:id          - Update workflow
DELETE /api/admin/workflows/:id          - Delete workflow

POST   /api/admin/workflows/:id/stages   - Add stage
PUT    /api/admin/workflows/:id/stages/:stageId - Update stage
DELETE /api/admin/workflows/:id/stages/:stageId - Delete stage

POST   /api/admin/workflows/:id/stages/:stageId/items - Add item
PUT    /api/admin/workflows/:id/items/:itemId        - Update item
DELETE /api/admin/workflows/:id/items/:itemId        - Delete item
```

### 3.2 Workflow Session (Agent)

```
POST   /api/agent-assist/workflow/start   - Start workflow session for interaction
GET    /api/agent-assist/workflow/session - Get current session state
POST   /api/agent-assist/workflow/analyze - Analyze transcript chunk (LLM)
PUT    /api/agent-assist/workflow/item/:id/complete - Manual item completion
PUT    /api/agent-assist/workflow/item/:id/skip     - Skip item
PUT    /api/agent-assist/workflow/slot/:name        - Manual slot update
POST   /api/agent-assist/workflow/complete          - Complete workflow session
```

### 3.3 Queue-Workflow Association

```
PUT    /api/admin/queues/:id/workflow    - Assign default workflow to queue
```

---

## 4. LLM Analysis Engine

### 4.1 Analysis Prompt Structure

For each incoming transcription chunk, send to GPT-4o:

```
SYSTEM:
You are analyzing a contact center conversation to track workflow completion.

Current workflow stage: "{stage_name}"
Pending items to detect:
{for each pending item}
- ID: {item_id}
  Type: {type}
  Label: "{label}"
  Detection hints: "{prompt_hint}"
  {if slot} Slot: {slot_name} ({slot_type})
{/for}

Previously filled slots:
{slots_filled as JSON}

Analyze the transcript and return JSON:
{
  "completed_items": [
    {
      "item_id": "uuid",
      "confidence": 0.95,
      "extracted_value": "value if slot",
      "source_text": "relevant transcript portion"
    }
  ],
  "detected_intent": "brief intent description",
  "sentiment": "positive|neutral|negative",
  "sentiment_score": 0-100
}

USER:
Speaker: {customer|agent}
Transcript: "{transcript_text}"
```

### 4.2 Analysis Triggers

- **On each transcription chunk** (debounced ~500ms)
- **Batch mode**: Collect 2-3 chunks, analyze together for context
- **Stage transition**: Re-analyze all pending items in new stage

### 4.3 Confidence Thresholds

- The LLM returns only an evidence-based `confidence` score from `0.0` to `1.0`.
- The application compares that score with the workflow's configured `llm_confidence_threshold`.
- `confidence >= llm_confidence_threshold`: mark the item `completed` and fill trusted slot values.
- `confidence < llm_confidence_threshold`: persist the value as `suggested` so the agent can confirm or correct it.
- Do not hardcode model-specific confidence ranges in prompts or runtime logic.

---

## 5. UI Components

### 5.1 AgentAssistWorkflow (Main Component)

Location: `components/contact-center/AgentAssistWorkflow.jsx`

```jsx
<AgentAssistWorkflow interactionId={id} workflowId={workflowId}>
  {/* Header: Stage navigation (1/3, 2/3, etc.) */}
  <WorkflowStageNav />
  
  {/* Main: Checklist of items for current stage */}
  <WorkflowChecklist />
  
  {/* Sidebar: Filled slots summary */}
  <WorkflowSlotsSummary />
  
  {/* Footer: Stage progress bar */}
  <WorkflowProgress />
</AgentAssistWorkflow>
```

### 5.2 Visual Design (per mockup)

- **Stage indicator**: "Call Opening (1/3)" with prev/next navigation
- **Checklist items**:
  - ✅ Completed: Purple checkmark, strikethrough text
  - ○ Pending: Empty circle, normal text
  - 🔄 In progress (LLM analyzing): Subtle pulse animation
- **Slot values**: Display extracted values inline or in sidebar
- **Timer**: Call duration display
- **Compact mode**: Collapsible for agent desktop integration

### 5.3 Integration with Existing AgentAssist

Options:
1. **Replace**: New component replaces current AgentAssist
2. **Tab**: Add "Workflow" tab alongside existing transcription/KB view
3. **Split view**: Workflow checklist on left, transcription on right

**Recommended**: Tab-based approach with workflow as primary, transcription as secondary tab.

---

## 6. Real-Time Updates

### 6.1 State Management (Zustand Store)

```javascript
// lib/stores/workflow-store.js
const useWorkflowStore = create((set, get) => ({
  session: null,
  stages: [],
  items: [],
  itemStatuses: {},
  slotsFilled: {},
  currentStageIndex: 0,
  
  // Actions
  setSession: (session) => set({ session }),
  updateItemStatus: (itemId, status) => set(...),
  updateSlot: (slotName, value) => set(...),
  nextStage: () => set(...),
  prevStage: () => set(...),
}));
```

### 6.2 SSE/WebSocket Updates

- Subscribe to `/api/agent-assist/workflow/events?sessionId=xxx`
- Events: `item.completed`, `slot.filled`, `stage.changed`, `session.completed`

---

## 7. Admin UI for Workflow Designer

### 7.1 Workflow List Page

Location: `/app/(portal)/admin/workflows/page.jsx`

- Table with workflows: Name, Category, Stages count, Status, Actions
- Create/Edit/Delete/Duplicate workflows

### 7.2 Workflow Editor Page

Location: `/app/(portal)/admin/workflows/[id]/page.jsx`

- **Left panel**: Stages list (drag to reorder)
- **Center panel**: Items for selected stage (drag to reorder)
- **Right panel**: Item editor (type, label, prompt hints, slot config)
- **Preview mode**: Test workflow with sample transcripts

---

## 8. Implementation Phases

### Phase 1: Core Infrastructure (3-4 days)
- [ ] Database schema migration
- [ ] API endpoints for workflow CRUD
- [ ] Basic workflow store (Zustand)
- [ ] Session management (start/stop)

### Phase 2: LLM Analysis Engine (2-3 days)
- [ ] Analysis prompt engineering
- [ ] Item completion detection
- [ ] Slot extraction
- [ ] Confidence scoring
- [ ] Integration with existing sentiment/intent

### Phase 3: Agent UI (3-4 days)
- [ ] WorkflowChecklist component
- [ ] Stage navigation
- [ ] Real-time updates (SSE)
- [ ] Manual completion/skip
- [ ] Slots summary panel

### Phase 4: Admin UI (2-3 days)
- [ ] Workflow list page
- [ ] Workflow editor (stages/items)
- [ ] Queue-workflow assignment
- [ ] Import/export workflows

### Phase 5: Polish & Testing (2 days)
- [ ] Edge cases handling
- [ ] Performance optimization (debouncing, batching)
- [ ] Sample workflows (sales, support, healthcare)
- [ ] Documentation

---

## 9. Sample Workflows to Create

### 9.1 Customer Support Call
- Opening → Verification → Issue Identification → Resolution → Closing

### 9.2 Sales Call
- Opening → Needs Discovery → Product Presentation → Objection Handling → Close

### 9.3 Healthcare Intake (GMR-style)
- Caller ID → Intent → Patient Info → Transport Details → Safety Questions → Confirmation

### 9.4 Survey/Feedback
- Introduction → Questions (slots) → Thank You

---

## 10. Success Metrics

- **Slot fill accuracy**: % of slots correctly auto-filled vs manual correction
- **Item detection accuracy**: % of items auto-completed vs manual
- **Agent efficiency**: Average handle time with/without workflow
- **Workflow completion rate**: % of calls completing full workflow

---

## Appendix A: Technology Stack

- **Database**: PostgreSQL (existing)
- **API**: Next.js API Routes (existing)
- **LLM**: Telnyx AI with GPT-4o (existing)
- **State**: Zustand (existing)
- **Real-time**: SSE (existing) or upgrade to WebSocket
- **UI**: React + shadcn/ui + Tailwind (existing)

## Appendix B: File Structure

```
lib/
  agent-assist/
    workflow-engine.js      # Core workflow logic
    workflow-analyzer.js    # LLM analysis
    workflow-prompts.js     # Prompt templates
  stores/
    workflow-store.js       # Zustand store

components/
  contact-center/
    AgentAssistWorkflow.jsx       # Main component
    WorkflowChecklist.jsx         # Checklist UI
    WorkflowStageNav.jsx          # Stage navigation
    WorkflowSlotsSummary.jsx      # Slots panel
    WorkflowProgress.jsx          # Progress bar

app/
  (portal)/
    admin/
      workflows/
        page.jsx                  # Workflow list
        [id]/
          page.jsx                # Workflow editor
  api/
    admin/
      workflows/
        route.js                  # CRUD workflows
        [id]/
          route.js
          stages/
            route.js
            [stageId]/
              route.js
              items/
                route.js
    agent-assist/
      workflow/
        start/route.js
        session/route.js
        analyze/route.js
        item/[id]/
          complete/route.js
          skip/route.js
        slot/[name]/route.js
        complete/route.js
        events/route.js           # SSE endpoint
```
