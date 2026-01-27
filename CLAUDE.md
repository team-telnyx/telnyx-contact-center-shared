# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Telnyx Contact Center is a Next.js 15 application providing a complete contact center solution built on Telnyx Voice APIs. It features a visual voice flow designer, skills-based call routing, real-time agent monitoring, and AI assistant integration.

## Development Commands

```bash
# Development
yarn dev                 # Start dev server (hostname 0.0.0.0:3000, FAST_REFRESH disabled)
yarn build              # Build for production
yarn start              # Start production server

# Database
yarn ensure:pg          # Set up PostgreSQL schema and tables

# Code Quality
yarn lint               # Run ESLint
```

## Architecture Overview

### Voice Flow Engine

The core of the system is a visual flow designer that executes Telnyx Voice API commands based on webhook events:

- **Flow Definition**: Voice flows are stored as ReactFlow graphs with nodes and edges in PostgreSQL (`voice_flows` table)
- **Execution Model**: Event-driven - each Telnyx webhook triggers flow execution from the current node
- **Node Types**: Defined in `config/voice-flow-nodes.js` - includes call control (answer, dial, bridge), audio (speak, play), input collection (gather), AI integration, recording, transcription, streaming, and logical operations
- **Engine**: `lib/voice-flow-engine.js` - handles node execution, variable substitution, and flow progression
- **Webhook Handler**: `app/api/voice/webhook/incoming/[flowId]/route.js` - receives Telnyx webhooks and triggers flow execution
- **Node Editors**: `components/voice-flow/` - custom React components for configuring each node type

Key concepts:
- Flows transition between nodes based on webhook events (e.g., `call.answered`, `call.hangup`)
- Variables can be substituted in node configs using `{{variable}}` notation
- Client state is used to maintain context across webhook calls
- Logical nodes (condition, switch, set_variable) execute immediately without API calls

### Contact Center

Skills-based routing system with real-time state management:

- **State Manager** (`lib/contact-center/state-manager.js`): In-memory cache with periodic DB sync for queue/agent/interaction state
- **Routing Engine** (`lib/contact-center/routing-engine.js`): FIFO, skills-based, and priority-based routing algorithms
- **Queue Router** (`lib/contact-center/queued-call-router.js`): Matches queued calls to available agents
- **Webhook Handler** (`lib/contact-center/webhook-handler.js`): Processes contact center events
- **User Status** (`lib/contact-center/user-status.js`): Manages agent availability states

The routing flow:
1. Calls are enqueued via the `enqueue` voice flow node
2. Queue options (name, priority, required skills) can be set via `set_queue_options` node
3. Routing engine finds best agent match based on skills, availability, and call priority
4. Agent is bridged to caller via `bridge` node with queue parameter
5. Real-time state updates tracked for monitoring

### Database Schema

PostgreSQL with key tables:

- **users**: Agent profiles with skills (JSONB), agent_status, max_concurrent_calls, queue assignments
- **skills**: Available skills in the system (name, category, is_active)
- **cc_queues**: Queue definitions with routing configuration
- **cc_queue_assignments**: Maps agents to queues with priority
- **cc_interactions**: Call interactions with state tracking
- **cc_agent_state**: Real-time agent availability state
- **cc_queue_state**: Real-time queue metrics
- **voice_flows**: Flow definitions as JSONB graphs

Schema managed in `lib/postgres-schema.mjs` and applied via `scripts/ensure-pg.mjs`.

### API Structure

Next.js App Router with route handlers in `app/api/`:

- `/api/voice/webhook/incoming/[flowId]` - Main Telnyx webhook endpoint for flow execution
- `/api/contact-center/` - Agent state, queue management, interaction handling
- `/api/admin/` - User management, queue configuration, call flows
- `/api/auth/` - NextAuth.js authentication endpoints
- `/api/ai/` - AI assistant integration (conversations, prompts)

### Frontend Structure

- **App Directory**: Next.js App Router with `(portal)` group for authenticated pages
- **Agent Desktop**: `/app/(portal)/agent/desktop` - real-time call handling interface
- **Flow Designer**: `/app/(portal)/admin/call-flows/[id]` - visual flow editor using ReactFlow
- **Components**: Radix UI-based component library in `components/ui/`
- **Sidebar Navigation**: Configured in `config/menu.jsx`

### State Management

- **Zustand stores** in `lib/stores/` for client-side state
- **Real-time updates**: Server-Sent Events (SSE) via `lib/sse.js` and `lib/session-monitor.js`
- **In-memory caching**: Contact center state for performance (`lib/contact-center/state-manager.js`)

## Key Technical Patterns

### Variable Substitution

Voice flow configs support variable interpolation:
- Format: `{{variable_name}}` or `{{path.to.nested.value}}`
- Engine: `lib/expression-engine.js` for expression evaluation
- Utils: `lib/variable-utils.js` for get/set operations on nested paths

### Authentication

- NextAuth.js for session management
- Local authentication strategy (username/password with PBKDF2)
- Custom PostgreSQL adapter (`lib/nextauth-pg-adapter.js`)
- Multi-role support stored in `users.roles` array

### Notifications

**CRITICAL**: Always use `notify` from `@/components/ToastNotify`, never import `toast` from `sonner` directly.

```javascript
import { notify } from "@/components/ToastNotify";

notify({
  title: "Success",
  description: "Operation completed",
  variant: "success"
});
```

### Integration with Telnyx API

When creating Telnyx API integrations:
1. Check `openapi/telnyx.json` for API specifications (if present)
2. Use `lib/telnyx.js` utilities for building URLs
3. Store credentials via `lib/telnyx-credentials.js`
4. Voice applications managed in `lib/telnyx-voice-apps.js`

### Styling

- Tailwind CSS v4 with custom configuration
- Absolute imports from `@/` (configured in `jsconfig.json`)
- Dark mode support via next-themes

## Important Conventions

- **Async/await over .then()**: Use async/await syntax consistently
- **Server code location**: API routes in `app/api/**`, server utilities in `lib/`
- **Client components**: Colocated in `app/**` directories
- **Match existing style**: Preserve indentation and formatting patterns in files

## Contact Center Specifics

### Skills-Based Routing

Skills format in user profiles and queue requirements:
```json
{
  "skill_uuid": proficiency_level,
  "skill_uuid_2": proficiency_level
}
```

Proficiency levels: 1-10 (higher is more skilled)

The routing engine converts UUIDs to skill names for matching and caches skill mappings for performance.

### Queue Configuration

Queues can be created dynamically via the `enqueue` flow node or pre-configured in the database:
- Queue name can use variable substitution: `{{username}}`
- Priority determines routing order (1-100)
- Required skills filter available agents
- Max wait time and max size configurable

### Agent Status Flow

1. Agent logs in → status set to "Available"
2. Agent activates queue → routing enabled for that queue
3. Call routed → status changes to "On Call"
4. Call ends → status returns to "Available" (or "Wrap Up" if configured)
5. Agent goes offline → deactivated from all queues

## Common Gotchas

1. **Voice Flow Execution**: Flows execute one node at a time per webhook - don't expect synchronous execution across multiple nodes
2. **Client State**: Must be base64-encoded JSON when passed to Telnyx API
3. **Skills vs Skill Names**: Database stores skill UUIDs, but routing engine converts to names
4. **In-memory State**: Contact center state is primarily in-memory - restarts clear state (ghost call cleanup handles this)
5. **Node Type vs Component Type**: In ReactFlow, `node.data.nodeType` contains the actual node type (e.g., "speak"), while `node.type` is often "customNode"

## Testing & Debugging

- No test suite configured - manual testing via UI and API calls
- Call logging: `lib/call-logger.js` logs all call events to database
- Real-time monitoring: `lib/call-monitor-store.js` for flow execution visualization
- Timeline tracking: `lib/contact-center/call-timeline-tracker.js` for interaction history
