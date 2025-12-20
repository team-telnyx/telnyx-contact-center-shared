# Contact Center Call Routing Architecture

## Overview

This document describes the implementation of the call routing system for the Telnyx Contact Center application. The system supports three routing algorithms (FIFO, Skills-based, and Priority-based) and provides real-time monitoring capabilities for up to 1000 concurrent calls and 1000 agents.

## Architecture Components

### 1. Database Schema

#### Tables Added:

- **cc_interactions**: Tracks all calls/interactions with their states, timing, and metadata
- **cc_queue_state**: Real-time state of queues (current size, wait times, agent counts)
- **cc_queue_statistics**: Aggregated hourly statistics for reporting
- **cc_agent_state**: Real-time state of agents (status, current calls, availability)

### 2. Routing Engine (`lib/contact-center/routing-engine.js`)

Implements three routing algorithms:

#### FIFO (First In, First Out)

- Routes to the agent who has been available the longest
- Prioritizes agents with no current calls
- Falls back to agents with lowest current call count

#### Skills-based Routing

- Matches call requirements with agent skills
- Scores agents based on:
  - Skill match ratio (must match at least one skill)
  - Skill proficiency levels
  - Agent availability status
  - Current capacity
- Returns the highest-scoring agent

#### Priority-based Routing

- Uses priority rules from queue configuration
- Scores agents based on:
  - Agent queue priority
  - Priority rules (skill levels, status, call priority)
  - Availability and capacity
- Returns the highest-priority agent

### 3. State Manager (`lib/contact-center/state-manager.js`)

Manages real-time state using a hybrid approach:

- **In-memory cache**: Fast access for routing decisions
- **Database sync**: Periodic sync (every 5 seconds) for persistence
- **Functions**:
  - `enqueueCall()`: Add call to queue
  - `assignCallToAgent()`: Assign call to agent
  - `answerCall()`: Mark call as answered
  - `completeCall()`: Mark call as completed/abandoned
  - `updateAgentStatus()`: Update agent availability
  - `updateAgentQueues()`: Update agent queue assignments

### 4. Statistics Aggregator (`lib/contact-center/stats-aggregator.js`)

Calculates real-time and historical statistics:

- **Queue Statistics**:

  - Real-time: current size, waiting calls, longest wait time
  - Today: total calls, answered/abandoned, avg wait/handle/talk times, service level
  - Agent counts: available, busy, total active

- **Agent Statistics**:

  - Current status and call count
  - Today's performance: total calls, completed, avg times
  - Queue assignments

- **Overall Statistics**:
  - Contact center-wide metrics
  - Aggregated across all queues and agents

### 5. API Endpoints

#### Routing Endpoints:

- `POST /api/contact-center/routing/route-call`: Route a call to an agent
- `POST /api/contact-center/routing/agent-status`: Update agent status

#### Statistics Endpoints:

- `GET /api/contact-center/stats/queues?queueId=xxx`: Get queue statistics
- `GET /api/contact-center/stats/agents?userId=xxx`: Get agent statistics

#### Monitoring Endpoints:

- `GET /api/contact-center/monitor/dashboard`: Get comprehensive dashboard data (admin only)
- `GET /api/contact-center/monitor/stream`: SSE stream for real-time updates (admin only)

### 6. Webhook Handler (`lib/contact-center/webhook-handler.js`)

Integrates with Telnyx webhooks:

- `handleIncomingCall()`: Process incoming call webhooks
- `handleCallAnswered()`: Process call answered events
- `handleCallEnded()`: Process call completion events

### 7. Supervisory Console (`app/(portal)/supervisor/monitor/page.jsx`)

Real-time dashboard showing:

- Overall statistics (calls, agents, wait times)
- Queue statistics table with real-time metrics
- Agent statistics table with performance metrics
- SSE connection for live updates

## Scalability Considerations

### For 1000+ Concurrent Calls and Agents:

1. **In-Memory State Cache**: Fast routing decisions without database queries
2. **Periodic Database Sync**: Reduces database load (syncs every 5 seconds)
3. **Indexed Database Queries**: All queries use proper indexes
4. **SSE Streaming**: Efficient real-time updates without polling
5. **Horizontal Scaling**: State manager can be moved to Redis for multi-instance deployments

### Performance Optimizations:

- Queue state cached in memory
- Agent availability cached in memory
- Statistics calculated on-demand with caching
- Database queries optimized with indexes
- SSE connections for real-time updates (no polling)

## Usage Examples

### Routing a Call:

```javascript
import { routeCall } from "@/lib/contact-center/routing-engine";

const result = await routeCall(queueId, {
  required_skills: { sales: 8, support: 6 },
  priority: 5,
  callControlId: "call_123",
});

if (result.success) {
  console.log("Routed to agent:", result.agent.username);
} else {
  console.log("Call queued:", result.reason);
}
```

### Updating Agent Status:

```javascript
import { updateAgentStatus } from "@/lib/contact-center/state-manager";

updateAgentStatus(userId, "Available", username);
```

### Getting Statistics:

```javascript
import { getQueueStatistics } from "@/lib/contact-center/stats-aggregator";

const stats = await getQueueStatistics(queueId);
console.log("Current queue size:", stats.realtime.currentSize);
console.log("Service level:", stats.today.serviceLevelPercentage);
```

## Future Enhancements

1. **Redis Integration**: Move state cache to Redis for multi-instance support
2. **Predictive Routing**: Use ML to predict best agent for call
3. **Workload Balancing**: Distribute calls more evenly across agents
4. **Advanced Reporting**: Historical trends, forecasting, agent performance analytics
5. **Queue Overflow Handling**: Better overflow queue routing logic
6. **Callback Scheduling**: Allow customers to schedule callbacks when queues are full

## Monitoring

The supervisory console provides real-time visibility into:

- Queue performance (wait times, service levels)
- Agent availability and utilization
- Call volumes and trends
- System health and connectivity

Access the console at: `/supervisor/monitor` (supervisor, admin, or owner roles)
