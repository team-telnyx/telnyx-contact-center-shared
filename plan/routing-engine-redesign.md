# Contact Center Routing Engine Redesign Plan

## Executive Summary

This plan redesigns the routing engine to implement contact center best practices for FIFO, priority-based, and skills-based routing with proper multi-queue agent support. The focus is on improving caller experience, preventing queue starvation, and implementing industry-standard routing strategies.

**Key Feature**: All priority and skills proficiency values use a **1-5 star rating system** (★☆☆☆☆ to ★★★★★) for consistent UI representation.

## Current Issues Identified

1. **No Longest Available Agent (LAA)**: Routes by fewest calls instead of idle time
2. **Multi-queue starvation**: High-priority queues can starve lower-priority queues
3. **Rigid skill matching**: 100% skill match required, no relaxation after wait time
4. **No call-level priority**: Only queue-level priority exists
5. **No SLA tracking**: No service level objectives or compliance metrics
6. **Global capacity only**: No per-queue agent capacity limits
7. **No agent utilization balancing**: Can overload some agents while others idle
8. **No expected wait time (EWT)**: No wait time estimates for callers
9. **Voice flow nodes outdated**: `enqueue` and `set_queue_options` nodes don't support new routing parameters
10. **UI gaps**: Agent and queue management UI missing fields for new routing parameters
11. **Inconsistent scales**: Skills use 1-10 scale, need to standardize to 1-5 stars

## Proposed Solutions

### 1. Enhanced Routing Algorithms

#### A. FIFO (Longest Available Agent - LAA)

**Current**: Routes to agent with fewest current calls
**Improved**: Routes to agent who has been idle longest

**Implementation Changes**:
- Track `last_call_ended_at` timestamp in `cc_agent_state`
- Track `available_since` timestamp (when agent became fully available)
- Sort by: `available_since` ASC (oldest first) → `current_calls_count` ASC → `queue_priority` DESC

**DB Schema Addition**:
```sql
ALTER TABLE cc_agent_state
ADD COLUMN last_call_ended_at TIMESTAMPTZ,
ADD COLUMN available_since TIMESTAMPTZ;
```

**Logic Update in `routeFIFO()`**:
```javascript
// For truly available agents (status=Available, 0 calls)
availableAgents.sort((a, b) => {
  // Longest available first (oldest available_since timestamp)
  const aTime = a.available_since ? new Date(a.available_since) : new Date();
  const bTime = b.available_since ? new Date(b.available_since) : new Date();
  if (aTime.getTime() !== bTime.getTime()) {
    return aTime - bTime; // Older = higher priority
  }
  // Fallback to queue priority
  return (b.queue_priority || 0) - (a.queue_priority || 0);
});
```

#### B. Skills-Based Routing with Relaxation

**Current**: Requires 100% skill match immediately
**Improved**: Relax skill requirements after configurable wait time threshold

**Implementation Changes**:
- Add `skill_relaxation_enabled` and `skill_relaxation_after_seconds` to `cc_queues`
- When routing queued calls, check wait time
- If wait time > threshold, reduce required proficiency levels progressively
- Track relaxation in routing metadata

**DB Schema Addition**:
```sql
ALTER TABLE cc_queues
ADD COLUMN skill_relaxation_enabled BOOLEAN DEFAULT false,
ADD COLUMN skill_relaxation_after_seconds INTEGER DEFAULT 60,
ADD COLUMN skill_relaxation_strategy TEXT DEFAULT 'progressive';
-- Strategies: 'progressive' (reduce by 1 star every 30s), 'fallback' (drop to 3 stars after threshold)
```

**Logic Update in `routeSkillsBased()`**:
```javascript
// Calculate adjusted required skills based on wait time
// Skills proficiency uses 1-5 star scale (same as call priority)
function getAdjustedSkillRequirements(requiredSkills, waitTimeSeconds, queue) {
  if (!queue.skill_relaxation_enabled) {
    return requiredSkills;
  }

  if (waitTimeSeconds < queue.skill_relaxation_after_seconds) {
    return requiredSkills; // No relaxation yet
  }

  const adjusted = {};
  const relaxationAmount = Math.floor(
    (waitTimeSeconds - queue.skill_relaxation_after_seconds) / 30
  ); // Reduce by 1 star every 30 seconds

  for (const [skill, level] of Object.entries(requiredSkills)) {
    adjusted[skill] = Math.max(1, level - relaxationAmount); // Min level = 1 star
  }

  return adjusted;
}
```

**Skills Proficiency Scale** (1-5 stars):
- ★☆☆☆☆ (1 star) = Beginner
- ★★☆☆☆ (2 stars) = Basic
- ★★★☆☆ (3 stars) = Intermediate
- ★★★★☆ (4 stars) = Advanced
- ★★★★★ (5 stars) = Expert

#### C. Priority-Based with Call-Level Priority

**Current**: Only queue-level priority
**Improved**: Support High/Normal/Low priority per call using 1-5 star scale

**IMPORTANT**: Skills-based routing calls can also have priority assigned. Priority and skills work together - high-priority calls with skill requirements will be matched to skilled agents first, before lower-priority calls.

**Implementation Changes**:
- Add `priority` field to `cc_interactions` (values: 1-5 stars, where 1=Low, 3=Normal, 5=High)
- Add `default_call_priority` to `cc_queues`
- Route high-priority calls before normal/low within same queue
- Sort queued calls by: `priority` DESC → `enqueued_at` ASC
- Skills-based + Priority: Match skills first, then use priority for order
- **UI Representation**: Display as 1-5 star rating (★☆☆☆☆ to ★★★★★)

**Call Priority Scale** (1-5 stars):
- ★☆☆☆☆ (1 star) = Low priority
- ★★☆☆☆ (2 stars) = Below normal
- ★★★☆☆ (3 stars) = Normal (default)
- ★★★★☆ (4 stars) = Above normal
- ★★★★★ (5 stars) = High priority

**DB Schema Addition**:
```sql
ALTER TABLE cc_interactions
ADD COLUMN priority INTEGER DEFAULT 3 CHECK (priority >= 1 AND priority <= 5);

ALTER TABLE cc_queues
ADD COLUMN default_call_priority INTEGER DEFAULT 3 CHECK (default_call_priority >= 1 AND default_call_priority <= 5);
```

**Logic Update in `offerQueuedCallForAgent()`**:
```javascript
// Sort queued interactions by priority then FIFO
const queuedInteractions = getQueuedInteractionsForQueues(activeQueueIds)
  .sort((a, b) => {
    // High priority first (5 stars before 1 star)
    const priorityDiff = (b.priority || 3) - (a.priority || 3);
    if (priorityDiff !== 0) return priorityDiff;

    // Then oldest first (FIFO)
    return new Date(a.enqueuedAt) - new Date(b.enqueuedAt);
  });
```

### 2. Multi-Queue Fairness Algorithm

**Current Issue**: Agent receives calls from highest-priority queue only, starving lower queues

**Proposed Solution**: Round-robin fairness with weighted queue priority

**Implementation Strategy**:

Add `last_call_from_queue_id` and `queue_call_counts` to track distribution:

```sql
ALTER TABLE cc_agent_state
ADD COLUMN last_call_from_queue_id TEXT,
ADD COLUMN queue_call_counts JSONB DEFAULT '{}';
-- Format: {"queue-1": 5, "queue-2": 3, "queue-3": 1}
```

**Fairness Algorithm**:

```javascript
// In offerQueuedCallForAgent(), instead of taking first match:

function selectFairQueue(activeQueues, agentState, queuedCalls) {
  // Get agent's call count per queue
  const queueCounts = agentState.queue_call_counts || {};

  // Calculate weighted score for each queue with pending calls
  const queueScores = activeQueues
    .filter(q => queuedCalls.some(call => call.queueId === q.id))
    .map(queue => {
      const callCount = queueCounts[queue.id] || 0;
      const lastQueuePenalty = agentState.last_call_from_queue_id === queue.id ? 50 : 0;

      // Score = queue priority - (calls taken * 10) - last queue penalty
      const score = (queue.priority || 0) - (callCount * 10) - lastQueuePenalty;

      return { queue, score };
    })
    .sort((a, b) => b.score - a.score); // Highest score wins

  return queueScores[0]?.queue || activeQueues[0];
}

// Select queue using fairness algorithm
const targetQueue = selectFairQueue(activeQueues, agentState, queuedInteractions);

// Find first suitable call from target queue
const call = queuedInteractions.find(call =>
  call.queueId === targetQueue.id &&
  agentMatchesSkills(agent, call)
);

if (call) {
  // Assign call and update queue_call_counts
  await updateQueueCallCount(agentId, targetQueue.id);
}
```

**Benefits**:
- Prevents starvation of lower-priority queues
- Balances agent workload across queues
- Still respects queue priority (higher priority gets more calls, but not ALL calls)

### 3. Agent Selection Improvements

#### Track Agent Idle Time

```sql
ALTER TABLE cc_agent_state
ADD COLUMN total_idle_seconds INTEGER DEFAULT 0,
ADD COLUMN total_handle_seconds INTEGER DEFAULT 0,
ADD COLUMN calls_handled_today INTEGER DEFAULT 0;
```

**Update on call completion**:
```javascript
// In completeCall()
const idleTime = calculateIdleTime(agent.available_since, now);
await updateAgentMetrics(agentId, {
  total_idle_seconds: agent.total_idle_seconds + idleTime,
  calls_handled_today: agent.calls_handled_today + 1
});
```

#### Agent Utilization Balancing

When multiple agents match, prefer agents with lower utilization:

```javascript
// Add to scoring in all routing algorithms
const utilizationScore = -(agent.calls_handled_today / (agent.total_idle_seconds + agent.total_handle_seconds + 1));
finalScore += utilizationScore * 5; // Weight for utilization
```

### 4. Service Level Agreement (SLA) Tracking

Add SLA configuration and real-time tracking:

```sql
-- Add SLA config to queues
ALTER TABLE cc_queues
ADD COLUMN sla_answer_threshold_seconds INTEGER DEFAULT 20,
ADD COLUMN sla_target_percentage INTEGER DEFAULT 80;
-- Example: Answer 80% of calls within 20 seconds

-- Track SLA metrics
CREATE TABLE cc_queue_sla_metrics (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  queue_id TEXT NOT NULL REFERENCES cc_queues(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_calls INTEGER DEFAULT 0,
  calls_answered INTEGER DEFAULT 0,
  calls_within_sla INTEGER DEFAULT 0,
  calls_abandoned INTEGER DEFAULT 0,
  avg_speed_of_answer_seconds DECIMAL(10,2),
  sla_compliance_percentage DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(queue_id, date)
);

CREATE INDEX idx_queue_sla_metrics_queue_date ON cc_queue_sla_metrics(queue_id, date);
```

**Track on call assignment**:
```javascript
async function recordSLAMetric(queueId, waitTimeSeconds, answered) {
  const queue = await getQueueConfig(queueId);
  const withinSLA = waitTimeSeconds <= queue.sla_answer_threshold_seconds;

  await upsertDailySLAMetrics(queueId, {
    total_calls: +1,
    calls_answered: answered ? +1 : 0,
    calls_within_sla: (answered && withinSLA) ? +1 : 0,
    calls_abandoned: !answered ? +1 : 0
  });
}
```

### 5. Per-Queue Agent Capacity (REMOVED)

**DECISION**: Per-queue agent capacity was removed. Only the global `user.max_concurrent_calls` setting is used for routing. This simplifies the routing logic and prevents confusion about capacity limits.

**Rationale**: 
- Simpler configuration and routing logic
- Global capacity is sufficient for most use cases
- Reduces complexity in agent assignment calculations

### 6. Expected Wait Time (EWT) Calculation

Provide estimated wait time to callers:

```javascript
export function calculateExpectedWaitTime(queueId) {
  const queueState = getRealtimeQueueMetrics(queueId);
  const agents = getAvailableAgentsForQueue(queueId);

  if (agents.length === 0) {
    return null; // No agents available
  }

  // Calculate average handle time from recent calls
  const avgHandleTime = getAverageHandleTime(queueId, last100Calls);

  // Calculate available agent capacity
  const availableCapacity = agents.reduce((sum, agent) =>
    sum + (agent.max_concurrent_calls - agent.current_calls_count), 0
  );

  // EWT = (calls in queue / available capacity) * average handle time
  const ewt = Math.ceil((queueState.currentSize / Math.max(1, availableCapacity)) * avgHandleTime);

  return ewt;
}
```

Store average handle time:
```sql
ALTER TABLE cc_queues
ADD COLUMN avg_handle_time_seconds INTEGER DEFAULT 180,
ADD COLUMN last_avg_calculated_at TIMESTAMPTZ;
```

## Critical Files to Modify

### 1. Database Schema (AUTO-MIGRATION)
**File**: `lib/postgres-schema.mjs`

**IMPORTANT**: All DB schema changes will be integrated into the existing `ensurePostgresSchema()` function using `DO $$ BEGIN ... IF NOT EXISTS ... END $$` blocks. This ensures automatic schema updates when running `yarn ensure:pg` or when the app starts.

**Changes**:
- Add columns to `cc_agent_state`: `last_call_ended_at`, `available_since`, `last_call_from_queue_id`, `queue_call_counts`, `total_idle_seconds`, `total_handle_seconds`, `calls_handled_today`
- Add columns to `cc_queues`: `skill_relaxation_enabled`, `skill_relaxation_after_seconds`, `skill_relaxation_strategy`, `default_call_priority`, `sla_answer_threshold_seconds`, `sla_target_percentage`, `avg_handle_time_seconds`, `last_avg_calculated_at`
- Update `cc_queues.priority`: Change from DEFAULT 0 to DEFAULT 1, add CHECK constraint (priority >= 1 AND priority <= 5)
- Add column to `cc_interactions`: `priority` (1-5 with CHECK constraint, DEFAULT 3)
- Update `cc_queue_user_assignments.priority`: Change DEFAULT to 1, add CHECK constraint (priority >= 1 AND priority <= 5)
- Create table: `cc_queue_sla_metrics`
- **Migrate existing skills from 1-10 to 1-5 scale**
- **NOTE**: Per-queue `max_concurrent_calls` was NOT added - only global user capacity is used

### 2. Routing Engine
**File**: `lib/contact-center/routing-engine.js`

**Changes**:
- Update `routeFIFO()`: Implement LAA logic using `available_since`
- Update `routeSkillsBased()`: Add skill relaxation logic based on wait time
- Update `routePriorityBased()`: Incorporate call-level priority from interaction
- Update `getAvailableAgentsForQueue()`: Include new state fields in query
- Add `calculateExpectedWaitTime()` function
- Add utilization scoring to agent selection
- **Update skill scoring to use 1-5 scale**

### 3. Queued Call Router
**File**: `lib/contact-center/queued-call-router.js`

**Changes**:
- Update `offerQueuedCallForAgent()`: Implement multi-queue fairness algorithm
- Sort queued calls by priority DESC (1-5 stars), enqueued_at ASC
- Track queue call counts per agent
- Update `queue_call_counts` after assignment

### 4. State Manager
**File**: `lib/contact-center/state-manager.js`

**Changes**:
- Update `updateAgentStatus()`: Set `available_since` when status changes to "Available"
- Update `completeCall()`: Set `last_call_ended_at`, calculate idle time, update metrics
- Update `assignCallToAgent()`: Update `last_call_from_queue_id`, increment queue counts
- Add `updateQueueCallCount()` function
- Add `updateAgentAvailability()` function to track availability time
- Include new fields in state sync

### 5. SLA Tracking (New)
**File**: `lib/contact-center/sla-tracker.js` (new file)

**Create new module**:
```javascript
export async function recordCallSLA(interactionId, queueId, waitTimeSeconds, answered) { ... }
export async function getDailySLAMetrics(queueId, date) { ... }
export async function getQueueSLACompliance(queueId, startDate, endDate) { ... }
export async function updateAverageHandleTime(queueId) { ... }
```

### 6. Webhook Handler
**File**: `lib/contact-center/webhook-handler.js`

**Changes**:
- Set `priority` on new interactions from queue.default_call_priority (1-5 scale)
- Record SLA metrics on call answer/abandon
- Calculate and update average handle time periodically

### 7. API Routes
**Files**:
- `app/api/contact-center/routing/route-call/route.js`
- `app/api/contact-center/agent/status/route.js`
- `app/api/contact-center/sla/[queueId]/route.js` (new)

**Changes**:
- Update routing API to accept call priority parameter (1-5 scale)
- Update agent status API to track availability timestamps
- Create SLA metrics API endpoint

### 8. Voice Flow Nodes (IMPLEMENTED)
**File**: `config/voice-flow-nodes.js`

**IMPORTANT ARCHITECTURAL DECISION**: 
- **Queue Priority**: Static parameter set in queue configuration only. NOT available in call flow nodes.
- **Call Priority**: Dynamic parameter available in call flow nodes (Set Queue Options, Enqueue Call).

**Rationale**: Queue priority determines routing between queues (which queue gets agents first). This should be static per queue, not dynamic per call. Call priority determines routing within a queue (which call gets routed first), which can vary per call.

**Update `set_queue_options` node** (IMPLEMENTED):
- ✅ Removed `priority` parameter (queue priority not configurable in call flow)
- ✅ Added `call_priority` parameter (1-5 star scale, supports variable)
- ✅ Skills array uses 1-5 proficiency levels
- ✅ Dynamic add/remove skills interface with duplicate prevention
- ✅ Skills limited to available skills count

**Updated config**:
```javascript
queue_name: string
call_priority: number (1-5)  // Call-level priority (star rating)
skills: array  // Array of {name, proficiency (1-5 stars)}
```

**Update `enqueue` node** (IMPLEMENTED):
- ✅ Added optional `call_priority` parameter (1-5 star scale)
- ✅ Removed `routing_priority` parameter (queue priority not configurable)
- ✅ Defaults to queue's `default_call_priority` if not specified
- ✅ Dynamic add/remove skills interface with duplicate prevention

**Config**:
```javascript
call_priority: {
  type: "number",
  label: "Call Priority",
  required: false,
  min: 1,
  max: 5,
  default: 3,
  description: "Call priority level (1-5 stars: 1=Low, 3=Normal, 5=High). Higher priority calls are routed first. Display as star rating in UI.",
}
```

### 9. Queue Management UI (REQUIRED)
**File**: `components/queues/EditSheet.jsx`

**Add new state variables and UI fields**:
```javascript
// New state for routing parameters
const [defaultCallPriority, setDefaultCallPriority] = React.useState(3);
const [skillRelaxationEnabled, setSkillRelaxationEnabled] = React.useState(false);
const [skillRelaxationAfterSeconds, setSkillRelaxationAfterSeconds] = React.useState(60);
const [skillRelaxationStrategy, setSkillRelaxationStrategy] = React.useState('progressive');
const [slaAnswerThresholdSeconds, setSlaAnswerThresholdSeconds] = React.useState(20);
const [slaTargetPercentage, setSlaTargetPercentage] = React.useState(80);
```

**Add UI sections** (after existing routing strategy selector):

1. **Call Priority Settings** (for all routing types):
   - Default Call Priority: 5-star rating component (1-5 stars)
   - Help text: "Default priority for calls entering this queue (★=Low, ★★★=Normal, ★★★★★=High)"
   - Use a star rating input component or slider with star icons

2. **Skill Relaxation Settings** (show when routing_strategy = "Skill-based"):
   - Enable Skill Relaxation toggle
   - Relaxation After Seconds input (default 60)
   - Relaxation Strategy select (progressive/fallback)
   - Help text: "Gradually reduce skill requirements for calls waiting beyond threshold (reduces by 1 star every 30 seconds, minimum 1 star)"

3. **SLA Settings** (for all routing types):
   - Answer Threshold (seconds) input (default 20)
   - Target Percentage input (default 80)
   - Help text: "Service Level Agreement: Answer X% of calls within Y seconds"

**Update `loadQueue()` and `saveQueue()` functions** to include new fields

**Queue Priority Settings** (IMPLEMENTED):
- ✅ Queue Priority: 5-star rating component (1-5 stars, default 1)
- ✅ Positioned above Call Priority Settings
- ✅ Help text: "Queue-level priority for routing (★=Low, ★★★=Normal, ★★★★★=High). Higher priority queues are routed first."
- ✅ Shown in queue list with clickable stars for direct editing

**User Assignments** (IMPLEMENTED):
- ✅ Queue Priority per user: 5-star rating (1-5 stars, default 1)
- ✅ Displayed in 2-column layout: user name and priority stars
- ✅ Removed per-queue max concurrent calls (only global user capacity used)

### 10. Agent/User Management UI (IMPLEMENTED)
**File**: `components/users/EditSheet.jsx`

**Changes implemented**:

1. ✅ **Skills editor** uses 1-5 star rating scale
   - Dynamic add/remove skills interface (like Set Queue Options node)
   - Prevents adding more skills than available
   - Prevents duplicate skill assignments
   - Star rating component for proficiency (1-5 stars)
   - Validation enforces 1-5 range

2. ✅ `max_concurrent_calls` field is editable (global user capacity)

3. ✅ Agent status dropdown includes all valid statuses

**Skills Interface**:
- "Add Skill" button (disabled when all skills assigned)
- Each skill row: Select dropdown (filters out already-selected skills) + Star rating + Remove button
- Empty state message when no skills assigned
- Validation prevents duplicates and incomplete selections

## Implementation Phases

### Phase 1: Database Schema (Foundation)
1. Update `lib/postgres-schema.mjs` with all schema changes using `DO $$ BEGIN ... END $$` migration blocks
2. **Add skills migration (1-10 to 1-5 scale)** for both users and queues
3. Run `yarn ensure:pg` to apply schema updates automatically
4. Verify all new columns exist with correct defaults
5. Test schema with existing data (backward compatibility check)

### Phase 2: Agent Availability Tracking
1. Update state manager to track `available_since` and `last_call_ended_at`
2. Update agent status changes to set availability timestamps
3. Implement LAA logic in FIFO routing
4. Test with multiple agents

### Phase 3: Call-Level Priority & Voice Flow Nodes
1. Update `set_queue_options` node in `config/voice-flow-nodes.js` to support `call_priority` parameter (1-5 scale)
2. Update `enqueue` node to support `call_priority` parameter (1-5 scale)
3. Update skills configuration to use 1-5 proficiency levels
4. Update node editors (if custom editors exist) to include priority field with star rating
5. Update enqueue webhook handler to read priority from node config and set on interaction
6. Update queued call sorting by priority DESC → enqueued_at ASC
7. Test priority routing with voice flows
8. **IMPORTANT**: Verify skills + priority work together (high-priority skilled calls route first)

### Phase 4: Multi-Queue Fairness
1. Implement queue call count tracking
2. Add fairness algorithm to queued call router
3. Update assignment logic to track queue distribution
4. Test with agents in multiple queues

### Phase 5: Skill Relaxation
1. Add relaxation configuration to queues
2. Implement progressive skill requirement reduction (1-5 star scale)
3. Update skill-based routing to use adjusted requirements
4. Test with varying wait times

### Phase 6: SLA Tracking
1. Create SLA metrics table
2. Implement SLA recording on call events
3. Create SLA API endpoints
4. Add SLA dashboard UI
5. Implement average handle time calculation

### Phase 7: UI Updates (REQUIRED)
1. Update `components/queues/EditSheet.jsx`:
   - Add Default Call Priority star rating component (1-5 stars)
   - Add Skill Relaxation settings section (conditional on routing_strategy)
   - Add SLA settings section
   - Add per-queue agent capacity in assignments table
   - Update load/save functions for new fields
2. Update `components/users/EditSheet.jsx`:
   - Replace skills proficiency input with 1-5 star rating component
   - Update validation (1-5 instead of 1-10)
3. Test queue creation/editing with all new parameters
4. Test agent assignment with per-queue capacity overrides
5. Test skills editing with star rating UI

### Phase 8: Advanced Features (Optional)
1. Per-queue agent capacity enforcement in routing logic
2. Expected wait time calculation and display
3. Agent utilization balancing refinements
4. Real-time SLA monitoring alerts
5. SLA dashboard and reporting UI

## Configuration Examples

### Queue with Skill Relaxation (1-5 Star Scale)
```json
{
  "name": "Technical Support",
  "routing_strategy": "Skill-based",
  "skill_requirements": {
    "Technical Support": 4,
    "Linux": 3
  },
  "skill_relaxation_enabled": true,
  "skill_relaxation_after_seconds": 60,
  "skill_relaxation_strategy": "progressive",
  "default_call_priority": 3
}
```

**Skill Relaxation Timeline** (1-5 star scale):
- Initial: Technical Support=4★, Linux=3★
- After 60 seconds: Technical Support=3★, Linux=2★
- After 90 seconds: Technical Support=2★, Linux=1★
- After 120 seconds: Technical Support=1★, Linux=1★ (minimum)

### Queue with SLA
```json
{
  "name": "Sales",
  "routing_strategy": "FIFO",
  "sla_answer_threshold_seconds": 20,
  "sla_target_percentage": 80,
  "default_call_priority": 3
}
```

Target: Answer 80% of calls within 20 seconds

### Agent Multi-Queue Assignment
```json
{
  "user_id": "agent-123",
  "assignments": [
    {
      "queue_id": "sales",
      "priority": 10,
      "max_concurrent_calls": 2
    },
    {
      "queue_id": "support",
      "priority": 5,
      "max_concurrent_calls": 1
    }
  ]
}
```

Agent can take 2 concurrent calls from Sales, 1 from Support (3 total)

### Agent Skills (1-5 Star Scale)
```json
{
  "user_id": "agent-456",
  "skills": {
    "skill-uuid-sales": 5,
    "skill-uuid-technical": 4,
    "skill-uuid-billing": 3
  }
}
```

Display: Sales ★★★★★, Technical ★★★★☆, Billing ★★★☆☆

## Backward Compatibility

- All new fields have defaults, existing queues work without changes
- Skill relaxation disabled by default
- Call priority defaults to 3 (Normal - middle of 1-5 star scale)
- **Skills proficiency scale changed from 1-10 to 1-5 (migration included)**
- LAA falls back to current call count if timestamps missing
- Per-queue capacity falls back to global if not set
- Fairness algorithm works with existing queue priority

### Skills Migration (1-10 to 1-5 Scale)

**CRITICAL**: Existing agent skills and queue skill requirements need automatic conversion:

**Conversion Formula**:
```javascript
// Map 1-10 scale to 1-5 scale
oldLevel <= 2  → 1 star (Beginner)
oldLevel <= 4  → 2 stars (Basic)
oldLevel <= 6  → 3 stars (Intermediate)
oldLevel <= 8  → 4 stars (Advanced)
oldLevel >= 9  → 5 stars (Expert)
```

**Examples**:
- 10 → 5 (expert)
- 8 → 4 (advanced)
- 6 → 3 (intermediate)
- 4 → 2 (basic)
- 2 → 1 (beginner)
- 1 → 1 (beginner)

## Verification & Testing

### Unit Tests
1. Test LAA agent selection with various availability times
2. Test skill relaxation calculation at different wait times (1-5 star scale)
3. Test multi-queue fairness scoring algorithm
4. Test SLA metric calculation
5. Test skills conversion from 1-10 to 1-5 scale

### Integration Tests
1. Enqueue 10 calls, verify LAA routing order
2. Enqueue call with high priority (5 stars) via `set_queue_options` node, verify it routes before older normal priority calls
3. Enqueue skilled call with high priority, verify skills matching + priority ordering works
4. Agent in 3 queues receives fair distribution over 30 calls
5. Skills relax after 60s, previously unmatched agent receives call
6. SLA compliance calculated correctly over 100 calls
7. Voice flow with `enqueue` node using `call_priority` parameter (1-5) works correctly
8. Queue UI saves and loads all new routing parameters correctly
9. Agent UI skills editor displays and saves 1-5 star ratings correctly

### Manual Testing
1. Activate agent for multiple queues, verify fairness over time
2. Set call priority to high (5 stars), verify immediate routing
3. Configure skill relaxation, observe matching after threshold
4. Monitor SLA dashboard, verify real-time updates
5. Edit agent skills with star rating UI, verify saves as 1-5 values
6. Create queue with skill requirements using 1-5 scale

### Performance Testing
1. Route 1000 concurrent calls, measure latency
2. Agent in 10 queues with 100 queued calls, measure selection time
3. 100 agents, 20 queues, verify state sync performance

## Success Metrics

1. **Fairness**: Standard deviation of queue call distribution < 20%
2. **SLA Compliance**: Meet configured SLA targets 95%+ of the time
3. **Idle Time**: Reduce agent idle time by 15%
4. **Queue Starvation**: All queues receive calls within 5 minutes
5. **Caller Satisfaction**: 90%+ of skill-based calls matched within 90 seconds (with relaxation)
6. **Performance**: Routing decision < 100ms for 95% of calls
7. **UI Consistency**: All priority and skills use 1-5 star rating system

## Automatic Schema Migration

**IMPORTANT**: No separate migration SQL file needed. All schema changes will be integrated directly into `lib/postgres-schema.mjs` using the existing `ensurePostgresSchema()` function.

### Integration into ensurePostgresSchema()

Add these blocks to the `ensurePostgresSchema()` function in `lib/postgres-schema.mjs` (after existing table creation):

```javascript
// Migration: Add routing engine enhancements to cc_agent_state
await client.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'last_call_ended_at') THEN
      ALTER TABLE cc_agent_state ADD COLUMN last_call_ended_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'available_since') THEN
      ALTER TABLE cc_agent_state ADD COLUMN available_since TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'last_call_from_queue_id') THEN
      ALTER TABLE cc_agent_state ADD COLUMN last_call_from_queue_id TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'queue_call_counts') THEN
      ALTER TABLE cc_agent_state ADD COLUMN queue_call_counts JSONB DEFAULT '{}'::jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'total_idle_seconds') THEN
      ALTER TABLE cc_agent_state ADD COLUMN total_idle_seconds INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'total_handle_seconds') THEN
      ALTER TABLE cc_agent_state ADD COLUMN total_handle_seconds INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'calls_handled_today') THEN
      ALTER TABLE cc_agent_state ADD COLUMN calls_handled_today INTEGER DEFAULT 0;
    END IF;
  END $$;
`);

// Migration: Add routing engine enhancements to cc_queues
await client.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'skill_relaxation_enabled') THEN
      ALTER TABLE cc_queues ADD COLUMN skill_relaxation_enabled BOOLEAN DEFAULT false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'skill_relaxation_after_seconds') THEN
      ALTER TABLE cc_queues ADD COLUMN skill_relaxation_after_seconds INTEGER DEFAULT 60;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'skill_relaxation_strategy') THEN
      ALTER TABLE cc_queues ADD COLUMN skill_relaxation_strategy TEXT DEFAULT 'progressive';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'default_call_priority') THEN
      ALTER TABLE cc_queues ADD COLUMN default_call_priority INTEGER DEFAULT 3 CHECK (default_call_priority >= 1 AND default_call_priority <= 5);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'sla_answer_threshold_seconds') THEN
      ALTER TABLE cc_queues ADD COLUMN sla_answer_threshold_seconds INTEGER DEFAULT 20;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'sla_target_percentage') THEN
      ALTER TABLE cc_queues ADD COLUMN sla_target_percentage INTEGER DEFAULT 80;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'avg_handle_time_seconds') THEN
      ALTER TABLE cc_queues ADD COLUMN avg_handle_time_seconds INTEGER DEFAULT 180;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'last_avg_calculated_at') THEN
      ALTER TABLE cc_queues ADD COLUMN last_avg_calculated_at TIMESTAMPTZ;
    END IF;
  END $$;
`);

// Migration: Add priority to cc_interactions
await client.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_interactions' AND column_name = 'priority') THEN
      ALTER TABLE cc_interactions ADD COLUMN priority INTEGER DEFAULT 3 CHECK (priority >= 1 AND priority <= 5);
    END IF;
  END $$;
`);

// NOTE: Per-queue capacity (max_concurrent_calls) was NOT implemented
// Only global user.max_concurrent_calls is used for routing

// Create SLA metrics table
await client.query(`
  CREATE TABLE IF NOT EXISTS cc_queue_sla_metrics (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    queue_id TEXT NOT NULL REFERENCES cc_queues(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    total_calls INTEGER DEFAULT 0,
    calls_answered INTEGER DEFAULT 0,
    calls_within_sla INTEGER DEFAULT 0,
    calls_abandoned INTEGER DEFAULT 0,
    avg_speed_of_answer_seconds DECIMAL(10,2),
    sla_compliance_percentage DECIMAL(5,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(queue_id, date)
  );
`);

await client.query(`
  CREATE INDEX IF NOT EXISTS idx_queue_sla_metrics_queue_date
  ON cc_queue_sla_metrics(queue_id, date);
`);

// CRITICAL: Migrate existing agent skills from 1-10 scale to 1-5 scale
await client.query(`
  UPDATE users
  SET skills = (
    SELECT jsonb_object_agg(
      key,
      CASE
        WHEN (value::text::integer) <= 2 THEN 1
        WHEN (value::text::integer) <= 4 THEN 2
        WHEN (value::text::integer) <= 6 THEN 3
        WHEN (value::text::integer) <= 8 THEN 4
        ELSE 5
      END
    )
    FROM jsonb_each(skills)
  )
  WHERE skills IS NOT NULL
    AND skills != '{}'::jsonb
    AND EXISTS (
      SELECT 1 FROM jsonb_each(skills)
      WHERE (value::text::integer) > 5
    );
`);

// CRITICAL: Migrate existing queue skill_requirements from 1-10 to 1-5 scale
await client.query(`
  UPDATE cc_queues
  SET skill_requirements = (
    SELECT jsonb_object_agg(
      key,
      CASE
        WHEN (value::text::integer) <= 2 THEN 1
        WHEN (value::text::integer) <= 4 THEN 2
        WHEN (value::text::integer) <= 6 THEN 3
        WHEN (value::text::integer) <= 8 THEN 4
        ELSE 5
      END
    )
    FROM jsonb_each(skill_requirements)
  )
  WHERE skill_requirements IS NOT NULL
    AND skill_requirements != '{}'::jsonb
    AND EXISTS (
      SELECT 1 FROM jsonb_each(skill_requirements)
      WHERE (value::text::integer) > 5
    );
`);
```

**To apply migrations**: Run `yarn ensure:pg` or restart the app (if schema initialization happens on startup)

## Implementation Status

### ✅ Completed

1. ✅ **Database Schema**: All schema changes implemented with auto-migration
   - Queue priority: 1-5 stars (default 1)
   - Call priority: 1-5 stars (default 3)
   - User queue priority: 1-5 stars (default 1)
   - Skills migration: 1-10 → 1-5 scale completed
   - SLA tracking tables and columns added
   - Agent state tracking fields added

2. ✅ **Routing Engine**: All routing algorithms updated
   - FIFO with LAA (Longest Available Agent) implemented
   - Skills-based routing with relaxation implemented
   - Priority-based routing with call-level priority implemented
   - Multi-queue fairness algorithm implemented

3. ✅ **Voice Flow Nodes**: Updated and tested
   - Set Queue Options: Call priority (1-5 stars), skills (1-5 stars), dynamic add/remove
   - Enqueue Call: Call priority (1-5 stars), skills (1-5 stars), dynamic add/remove
   - Queue priority removed from call flow nodes (static in queue config only)

4. ✅ **Queue Management UI**: Complete implementation
   - Queue Priority Settings (1-5 stars) above Call Priority Settings
   - Queue list shows priority with clickable stars for direct editing
   - User assignments show queue priority (1-5 stars) in 2-column layout
   - All routing parameters configurable

5. ✅ **Agent/User Management UI**: Complete implementation
   - Skills editor: Dynamic add/remove interface (1-5 stars)
   - Prevents duplicates and limits to available skills
   - Star rating component for proficiency

6. ✅ **State Manager**: Updated to track all new metrics
   - Agent availability timestamps
   - Queue call counts per agent
   - Agent utilization metrics

7. ✅ **Webhook Handler**: Updated to handle call priority
   - Reads call priority from routing metadata or queue default
   - Sets interaction priority correctly

8. ✅ **Queued Call Router**: Multi-queue fairness implemented
   - Sorts calls by priority DESC, then FIFO
   - Uses queue priority in fairness scoring
   - Tracks queue call distribution per agent

### 🔍 Key Architectural Decisions

1. **Queue Priority**: Static parameter set in queue configuration only. NOT available in call flow nodes. Range: 1-5 stars (default 1).

2. **Call Priority**: Dynamic parameter available in call flow nodes. Range: 1-5 stars (default 3, or queue's default_call_priority).

3. **User Queue Priority**: Set per user per queue in queue assignments. Range: 1-5 stars (default 1). Used in routing to prioritize agents within a queue.

4. **Per-Queue Capacity**: Removed. Only global `user.max_concurrent_calls` is used.

5. **Skills**: All use 1-5 star scale. Dynamic add/remove interface prevents duplicates and limits to available skills.

## Parameter Usage Summary

### Queue Priority (`cc_queues.priority`)
- **Type**: Static (queue configuration only)
- **Range**: 1-5 stars (default 1)
- **Used in**:
  - Multi-queue fairness algorithm (queued-call-router.js)
  - FIFO routing agent selection (routing-engine.js)
  - Priority-based routing scoring (routing-engine.js)
- **Set in**: Queue configuration sheet, queue list (clickable stars)

### Call Priority (`cc_interactions.priority`)
- **Type**: Dynamic (per call)
- **Range**: 1-5 stars (default 3, or queue.default_call_priority)
- **Set from**: 
  - Set Queue Options node (`call_priority`)
  - Enqueue Call node (`call_priority`)
  - Queue default (`default_call_priority`)
- **Used in**:
  - Queued call sorting (priority DESC, then FIFO)
  - Priority-based routing algorithm
- **Stored in**: `cc_interactions.priority`

### User Queue Priority (`cc_queue_user_assignments.priority`)
- **Type**: Static (per user per queue)
- **Range**: 1-5 stars (default 1)
- **Used in**:
  - FIFO routing agent selection
  - Priority-based routing scoring
- **Set in**: Queue configuration sheet (user assignments section)

### Skills Proficiency
- **Type**: Dynamic (per user, per call requirement)
- **Range**: 1-5 stars
- **Stored in**: `users.skills` (JSONB), `cc_interactions.required_skills` (JSONB)
- **Used in**: Skills-based routing with relaxation
- **Set in**: User sheet (dynamic add/remove), Call flow nodes (dynamic add/remove)

## Next Steps (Future Enhancements)

1. Add real-time metrics display in agent/user UI
2. Add SLA dashboard/visualization
3. Add expected wait time (EWT) calculation and display
4. Add routing analytics and reporting
5. Performance optimization for large-scale deployments
