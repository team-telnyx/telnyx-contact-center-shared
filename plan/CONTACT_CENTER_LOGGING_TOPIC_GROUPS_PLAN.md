# Contact Center Logging Topic Groups Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add complete Contact Center runtime logging without creating an unmanageable number of Admin Logging topics.

**Architecture:** Keep the topic catalog intentionally small: around 10 human-operable groups and no more than about 50 leaf topics. Runtime logger level resolution should use group inheritance first, then topic overrides. Admin Logging Settings must expose group-level controls with per-topic overrides; Live/Files filters must expose grouped topic selection where operators can select a whole group or individual topics.

**Tech Stack:** Next.js App Router, React Admin UI, pino via `lib/diagnostic-logger.mjs`, runtime config in `lib/logger/runtime-config.mjs`, Admin Logging APIs under `app/api/admin/logging/*`, source-level contract tests with `node:test`.

---

## 1. Problem Statement

The existing logging migration introduced the right pino/JSONL foundation, but the first Contact Center audit showed that a naive migration would create too many topics. That would make the Admin Logging Settings page and the Live/Files topic filter difficult to use.

Current relevant facts from the codebase:

- `lib/logger/index.mjs` already supports hierarchical inheritance for `topicLevels` and `topicEnabled` by walking parent dot-prefixes.
  - Example: `contact-center.routing` can inherit from `contact-center` if no exact level is configured.
- `app/(portal)/admin/logging/page.jsx` currently renders topics as a flat list in Settings.
- `TopicMultiSelect` currently renders topics as a flat checkbox list in Live/Files Filters.
- `lib/logger/runtime-config.mjs` has flat `DEFAULT_TOPIC_LEVELS` and `DEFAULT_TOPIC_ENABLED`.
- Important runtime areas still use `console.*`, especially Contact Center routing/status/interactions/transfer/consult/supervision, Voice Flow runtime, Agent Assist, Outbound Dialer, and browser-side Contact Center components.

The target is **not** to create one topic per file or class. The target is a compact, stable operational taxonomy.

---

## 2. Design Principles

1. **Max ~50 topics total**
   - Target: around 50 leaf topics. Most groups should stay around five topics, but a broad product area such as Contact Center may have more when that keeps topic IDs two-level and easier to operate.
   - Hard guardrail: do not exceed 50 leaf topics without explicit product decision.

2. **Around 10 groups**
   - Most groups should contain about 3-5 topics; broader product domains may have more when that avoids artificial third-level topic names.
   - A group maps to a business/operational domain, not a source folder.

3. **Group inheritance first, topic override second**
   - Group level controls broad noise.
   - Topic-level override handles a focused incident.
   - Example: keep `contact-center = info`, temporarily set `contact-center.timeout = debug`.

4. **Topics are stable API, event names carry detail**
   - Avoid topic explosion like `contact-center.routing.agent.no-answer.timeout.requeue`.
   - Put detail in `msg` and structured fields instead:
     - topic: `contact-center.timeout`
     - msg: `agent_answer_timeout_requeue_completed`
     - fields: `interactionId`, `callControlId`, `agentUserId`, `queueId`, `reason`

5. **No bracket-prefixed string logs**
   - Replace `[RoutingEngine] ...` with pino event names.
   - `msg` should be technical snake_case.
   - human `message` should come from the friendly formatter.

6. **Settings and Filters must reflect the same taxonomy**
   - The topic catalog should be defined once and reused by runtime defaults, Settings UI, and Filters UI.

7. **Security-sensitive payloads stay redacted**
   - Do not log raw passwords, API keys, tokens, bearer strings, ID tokens, refresh tokens, secrets, credentials, full client_state blobs, or provider raw responses.

---

## 3. Proposed Topic Catalog

### Summary

- Groups: **10**
- Leaf topics: **50**
- Group parent topics are stored in config for level inheritance and UI controls. Emitted leaf topics should remain two-level: `group.topic`.

Primary group or namespace parent topics should be valid config keys:

- `platform`
- `security`
- `contact-center`
- `voice`
- `telnyx`
- `agent-assist`
- `outbound`
- `supervisor`
- `notifications`
- `frontend`

### Group 1: Platform & Runtime

Purpose: app startup, DB, scheduler, runtime logging itself, generic API infrastructure.

Leaf topics:

1. `platform.app`
2. `platform.api`
3. `platform.db`
4. `platform.scheduler`
5. `platform.logging`

Migration mapping:

- Current `app` -> `platform.app`
- Current `api` -> `platform.api`
- Current `db` -> `platform.db`
- Current `scheduler` -> `platform.scheduler`
- Logger internal events -> `platform.logging`

Default levels:

- group `platform`: `info`
- `platform.db`: `warn`
- `platform.logging`: `info`

### Group 2: Security & Auth

Purpose: authentication, sessions, users, secrets/credentials hygiene, admin security actions.

Leaf topics:

1. `security.auth`
2. `security.sessions`
3. `security.users`
4. `security.credentials`
5. `security.admin`

Migration mapping:

- Current `auth` -> `security.auth`
- Existing auth helper may keep backward-compatible alias during migration.
- `lib/secrets.js`, `lib/telnyx-credentials.js` -> `security.credentials`

Default levels:

- group `security`: `info`
- `security.credentials`: `warn`

### Group 3: Contact Center

Purpose: Contact Center runtime: agent status, queue membership, routing, reservations, no-answer/requeue behavior, live interaction lifecycle, wrap-up, transfer, consult, and supervision.

Leaf topics:

1. `contact-center.status`
2. `contact-center.queues`
3. `contact-center.routing`
4. `contact-center.reservations`
5. `contact-center.timeout`
6. `contact-center.interactions`
7. `contact-center.wrapup`
8. `contact-center.transfer`
9. `contact-center.consult`
10. `contact-center.supervision`

Migration mapping:

- `lib/contact-center/routing-engine.js` -> `contact-center.routing`
- `lib/contact-center/agent-answer-timeout.js` -> `contact-center.timeout`
- queue activation/deactivation/list/calls routes -> `contact-center.queues`
- reservation manager -> `contact-center.reservations`
- agent status routes -> `contact-center.status`
- answer/history/by-call-control-id/transcription routes -> `contact-center.interactions`
- wrapup/wrapup-codes routes -> `contact-center.wrapup`
- transfer routes -> `contact-center.transfer`
- consult routes -> `contact-center.consult`
- supervise/switch-supervisor-role routes -> `contact-center.supervision`

Default level:

- group `contact-center`: `info`

Note: Contact Center intentionally has more than five topics because it is the richest operational domain in the application. Keeping it as two-level `contact-center.topic` is more important than forcing artificial subgroups such as `contact-center.calls.transfer`.

### Group 4: Voice & Call Flow

Purpose: Voice API webhook handling, flow execution, call-control actions, recordings, monitor streams.

Leaf topics:

1. `voice.webhooks`
2. `voice.flow`
3. `voice.call-control`
4. `voice.recordings`
5. `voice.monitor`

Migration mapping:

- `app/api/voice/webhook/incoming/[flowId]/route.js` -> `voice.webhooks`
- `lib/voice-flow-engine.js` -> `voice.flow`
- `app/api/voice/call-action/route.js`, state/call-leg routes -> `voice.call-control`
- recordings/transcribe routes -> `voice.recordings`
- flow monitor stream routes -> `voice.monitor`

Default level:

- group `voice`: `info`

### Group 5: Telnyx Media & Provider Integrations

Purpose: Telnyx STT/media streaming/WebSocket/provider calls. Keep this separate from business Contact Center decisions.

Leaf topics:

1. `telnyx.webhooks`
2. `telnyx.streaming`
3. `telnyx.stt`
4. `telnyx.media`
5. `telnyx.provider-api`

Migration mapping:

- Current `telnyx.webhook` -> `telnyx.webhooks`
- Current `telnyx.streaming` -> keep
- Current `telnyx.stt` -> keep
- Current `telnyx.stt.media` -> `telnyx.media`
- Telnyx REST/SDK call failures -> `telnyx.provider-api`

Default levels:

- group `telnyx`: `info`
- `telnyx.media`: `warn` because raw media frame logging is noisy

### Group 6: Agent Assist & AI

Purpose: Agent Assist workflow analysis, suggestions, translation, handoff, LLM/provider interactions.

Leaf topics:

1. `agent-assist.workflow`
2. `agent-assist.suggestions`
3. `agent-assist.translation`
4. `agent-assist.handoff`
5. `agent-assist.llm`

Migration mapping:

- workflow analyzer and workflow APIs -> `agent-assist.workflow`
- generate suggestion route -> `agent-assist.suggestions`
- translation service -> `agent-assist.translation`
- ai handoff processor -> `agent-assist.handoff`
- direct model/provider calls -> `agent-assist.llm`

Default levels:

- group `agent-assist`: `info`
- `agent-assist.llm`: `warn` by default unless actively debugging AI behavior

### Group 7: Outbound Dialer

Purpose: outbound runner, campaign execution, agent campaigns, imports, live calls.

Leaf topics:

1. `outbound.runner`
2. `outbound.campaigns`
3. `outbound.execution`
4. `outbound.imports`
5. `outbound.live-calls`

Migration mapping:

- `lib/outbound-dialer/runner.js` -> `outbound.runner`
- campaign CRUD/settings where operationally relevant -> `outbound.campaigns`
- campaign start/stop/pause/resume -> `outbound.execution`
- contact list/DNC imports -> `outbound.imports`
- live calls REST/SSE -> `outbound.live-calls`

Default level:

- group `outbound`: `info`

### Group 8: Supervisor & Reporting

Purpose: supervisor monitor, dashboards, stats, metrics, call summaries, insights.

Leaf topics:

1. `supervisor.monitor`
2. `supervisor.dashboard`
3. `supervisor.metrics`
4. `supervisor.reports`
5. `supervisor.insights`

Migration mapping:

- supervisor monitor page/server endpoints -> `supervisor.monitor`
- stats aggregator -> `supervisor.metrics`
- call metrics tracker / call summary -> `supervisor.reports`
- Telnyx insights helper -> `supervisor.insights`

Default level:

- group `supervisor`: `info`

### Group 9: Notifications

Purpose: email and push notification delivery.

Leaf topics:

1. `notifications.email`
2. `notifications.push`

Migration mapping:

- `lib/email-notifications.js` -> `notifications.email`
- `lib/push-notifications.js` -> `notifications.push`

Default level:

- group `notifications`: `info`

### Group 10: Browser Client

Purpose: optional client-side telemetry. Keep browser UI noise separate from backend runtime logs.

Leaf topics:

1. `frontend.agent-desktop`
2. `frontend.supervisor`
3. `frontend.admin`

Migration mapping:

- `components/contact-center/AgentDesktop.jsx` -> `frontend.agent-desktop` only if client telemetry endpoint is added
- `components/contact-center/SupervisionModal.jsx` and supervisor pages -> `frontend.supervisor`
- Admin call-flow editor debug telemetry -> `frontend.admin`

Default level:

- group `frontend`: `warn`

Important: Do not blindly replace browser `console.log` with server pino. Either remove noisy dev logs, gate them behind a debug flag, or send selected operational client events through a dedicated client telemetry endpoint.

---

## 4. Effective Level Resolution

Current behavior in `lib/logger/index.mjs` already walks dot parents:

1. exact topic level, e.g. `contact-center.transfer`
2. parent topic level, e.g. `contact-center`
3. global level

Keep this behavior. The UI should make it visible.

Required operator model:

- Global level: default fallback for everything.
- Group level: e.g. `contact-center = info`.
- Topic override: e.g. `contact-center.transfer = debug`.
- Topic enabled: exact override wins; otherwise parent group enabled/disabled wins.

Example runtime config:

```json
{
  "globalLevel": "warn",
  "topicLevels": {
    "contact-center": "info",
    "contact-center.transfer": "debug",
    "telnyx.media": "warn"
  },
  "topicEnabled": {
    "frontend": false,
    "frontend.agent-desktop": true
  }
}
```

Effective behavior:

- All Contact Center topics emit `info+` because they inherit from `contact-center`.
- Transfer emits `debug+`.
- Frontend is disabled by default.
- Agent Desktop frontend telemetry is re-enabled as an explicit exception.

---

## 5. Data Model Changes

### 5.1 Add canonical topic catalog

Create:

- `lib/logger/topic-catalog.mjs`

Exports:

```js
export const LOGGING_TOPIC_GROUPS = [
  {
    id: "contact-center",
    label: "Contact Center",
    description: "Routing, queues, status, interactions and live call control.",
    defaultLevel: "info",
    topics: [
      { id: "contact-center.status", label: "Agent status", defaultLevel: "info" },
      { id: "contact-center.queues", label: "Queues", defaultLevel: "info" },
      { id: "contact-center.routing", label: "Routing", defaultLevel: "info" },
      { id: "contact-center.reservations", label: "Reservations", defaultLevel: "info" },
      { id: "contact-center.timeout", label: "No-answer timeouts", defaultLevel: "info" },
      { id: "contact-center.interactions", label: "Interactions", defaultLevel: "info" },
      { id: "contact-center.wrapup", label: "Wrap-up", defaultLevel: "info" },
      { id: "contact-center.transfer", label: "Transfer", defaultLevel: "info" },
      { id: "contact-center.consult", label: "Consult", defaultLevel: "info" },
      { id: "contact-center.supervision", label: "Supervision", defaultLevel: "info" }
    ]
  }
];

export function flattenLoggingTopics(groups = LOGGING_TOPIC_GROUPS) {}
export function defaultTopicLevelsFromCatalog(groups = LOGGING_TOPIC_GROUPS) {}
export function defaultTopicEnabledFromCatalog(groups = LOGGING_TOPIC_GROUPS) {}
export function topicGroupForTopic(topic, groups = LOGGING_TOPIC_GROUPS) {}
```

The actual file should include all 10 groups listed in this plan.

### 5.2 Runtime defaults

Modify:

- `lib/logger/runtime-config.mjs`

Replace hardcoded `DEFAULT_TOPIC_LEVELS` / `DEFAULT_TOPIC_ENABLED` with catalog-derived defaults.

Keep backward compatibility aliases during migration:

- `app` may remain accepted but UI should prefer `platform.app`.
- `db` may remain accepted but UI should prefer `platform.db`.
- `auth` may remain accepted but UI should prefer `security.auth`.
- historical `telnyx.stt.media` may remain accepted as a legacy alias, but new emitted topics and UI should prefer two-level `telnyx.media`.
- `outbound-dialer` may remain accepted but UI should prefer `outbound.*`.

Recommended alias handling:

```js
export const LEGACY_TOPIC_ALIASES = Object.freeze({
  app: "platform.app",
  api: "platform.api",
  db: "platform.db",
  auth: "security.auth",
  admin: "security.admin",
  "telnyx.webhook": "telnyx.webhooks",
  "telnyx.stt.media": "telnyx.media",
  "voice-flow": "voice.flow",
  monitor: "supervisor.monitor",
  "outbound-dialer": "outbound.campaigns"
});
```

Do not delete legacy topic support in the first PR. The log files may contain historical entries with old topics and filters should still find them.

---

## 6. Admin Logging Settings UX

Current issue:

- `SettingsView` renders a flat list of topic cards.
- This will not scale to 50 topics plus aliases.

Target UI:

### 6.1 Group cards

Settings should show group cards. Each group card contains:

- Group label, group topic id, description.
- Group enabled switch.
- Group level tabs.
- Summary: `N topics`, `M overrides`, `X disabled`.
- Expand/collapse button for child topics.

Group controls write to existing flat config keys:

- group level -> `topicLevels[group.id]`
- group enabled -> `topicEnabled[group.id]`

No DB schema change required.

### 6.2 Topic override rows

Inside each expanded group:

- one row per child topic
- effective level badge
- topic enabled checkbox/switch
- level tabs for explicit override
- `Inherit group` button that removes exact `topicLevels[topic.id]`
- `Inherit enabled` button that removes exact `topicEnabled[topic.id]`

Topic controls write to:

- exact topic level -> `topicLevels[topic.id]`
- exact topic enabled -> `topicEnabled[topic.id]`

### 6.3 Visual states

Each child topic row should show one of:

- `Inherited from group: INFO`
- `Override: DEBUG`
- `Disabled by group`
- `Explicitly enabled`
- `Explicitly disabled`

### 6.4 Custom topics

The current `Add topic` input should not stay as a primary affordance.

Recommendation:

- Hide under `Advanced / Custom topics`.
- Still allow custom topics for emergency or plugin future use.
- Custom topics should appear in an `Custom / Ungrouped` section.
- Add warning text: “Prefer the standard catalog unless this is temporary or plugin-owned.”

Files to modify:

- `app/(portal)/admin/logging/page.jsx`
- possibly extract components to `components/admin/logging/TopicPolicyEditor.jsx` if the page gets too large

---

## 7. Live/Files Topic Filter UX

Current issue:

- `TopicMultiSelect` renders a flat checkbox list.

Target:

- The dropdown must render grouped sections.
- Operators can select a whole group or individual topics.
- Selecting a group sends all child topics as `topics` repeated query params initially, unless the API is enhanced to accept `topicGroups`.

### 7.1 Recommended simple implementation

Keep the API unchanged for first implementation:

- filter state remains `topics: []`
- selecting group toggles all child topic IDs in that group
- selected summary shows:
  - `All topics` if none selected
  - `Contact Center group` if all topics in one group are selected
  - `Contact Center + 2 topics` if one full group plus extras
  - `7 selected` fallback

Pros:

- no backend API change needed
- Live, Files and SSE already support repeated `topics`
- works with current log filtering

Cons:

- if new topics are later added to a selected group, old URL/filter state does not automatically include the new topic

### 7.2 Future API enhancement

Later optional enhancement:

- add `topicGroups` repeated query param to logs and stream APIs
- backend expands group IDs using catalog on every request

This is not required for the first implementation.

### 7.3 Dropdown behavior

Popover layout:

- top action: `All topics`
- search input: filter groups/topics by label/id
- per group:
  - group checkbox with indeterminate state
  - group label and count
  - expand/collapse child topics
  - child topic checkboxes

Required accessibility:

- group checkbox has `aria-checked="mixed"` when partially selected
- child topic labels use topic id in monospace and friendly label in normal text

Files to modify:

- `app/(portal)/admin/logging/page.jsx`
- maybe extract `GroupedTopicMultiSelect` to `components/admin/logging/GroupedTopicMultiSelect.jsx`

---

## 8. Backend Filter Behavior

Existing APIs:

- `app/api/admin/logging/logs/route.js`
- `app/api/admin/logging/stream/route.js`

Current behavior already accepts:

- legacy single `topic`
- repeated `topics`

For first implementation:

- no API change required if UI expands groups to topics.

If `topicGroups` is implemented later:

- add `queryParams(request, "topicGroups")`
- validate group IDs against `LOGGING_TOPIC_GROUPS`
- expand to topic IDs server-side
- merge with explicit `topics`
- keep legacy `topic` compatibility

Important: filter matching should remain exact topic matching, not prefix matching, unless explicitly selected. Prefix matching could surprise operators when selecting `telnyx` and suddenly including noisy `telnyx.media`.

---

## 9. Migration Plan for Logging Sources

### Phase A: Topic taxonomy and UI foundation

Objective: implement grouped topic catalog and grouped Admin UI before migrating hundreds of logs.

Files:

- Create: `lib/logger/topic-catalog.mjs`
- Modify: `lib/logger/runtime-config.mjs`
- Modify: `app/(portal)/admin/logging/page.jsx`
- Modify: `tests/logger-runtime-config.test.mjs`
- Modify: `tests/admin-logging-ui.test.mjs`
- Modify: `tests/logging-startup-polish.test.mjs`

Acceptance criteria:

- Runtime defaults expose group parent keys and leaf topic keys.
- Settings page renders grouped topic level controls.
- Group level writes `topicLevels[groupId]`.
- Topic override writes `topicLevels[topicId]`.
- Topic can inherit from group by deleting exact override.
- Filters dropdown displays groups and allows group selection.
- Repeated `topics` query params still used for Live/Files/SSE.

Verification:

```bash
node --test tests/admin-logging-ui.test.mjs tests/logging-startup-polish.test.mjs tests/logger-runtime-config.test.mjs tests/logging-logs-api-contract.test.mjs tests/logging-live-sse-contract.test.mjs
NODE_ENV=production yarn build
```

### Phase B: Contact Center helper and P0 backend migration

Objective: start logging migration using the new taxonomy.

Files:

- Create: `lib/contact-center/logging.mjs`
- Modify: `lib/contact-center/routing-engine.js`
- Modify: `lib/contact-center/agent-answer-timeout.js`
- Modify: `lib/contact-center/reservation-manager.js`
- Modify: `app/api/contact-center/agent/status/route.js`
- Modify: `app/api/contact-center/routing/agent-status/route.js`
- Modify: `app/api/contact-center/routing/route-call/route.js`
- Create: `tests/contact-center-logging-contract.test.mjs`

Required helper behavior:

```js
export function createContactCenterLogger(topic, bindings = {}) {
  return createDiagnosticLogger(topic, bindings);
}

export function contactCenterErrorPayload(error) {}
export function callPayload({ interactionId, callControlId, callSessionId }) {}
export function agentPayload({ agentUserId, agentUsername, extension }) {}
```

Topic usage:

- routing decisions -> `contact-center.routing`
- no-answer and requeue -> `contact-center.timeout`
- reservations -> `contact-center.reservations`
- agent status changes -> `contact-center.status`

Acceptance criteria:

- No `console.*` remains in the touched P0 files.
- No bracket-prefixed event strings remain in touched P0 files.
- Event names are snake_case in `msg`.
- Safe context fields included: `interactionId`, `callControlId`, `callSessionId`, `agentUserId`, `queueId`, `reason`.

### Phase C: Interactions, Transfer, Consult, Supervision

Files:

- `app/api/contact-center/interactions/[id]/answer/route.js`
- `app/api/contact-center/interactions/[id]/wrapup/route.js`
- `app/api/contact-center/interactions/[id]/timeout-check/route.js`
- `app/api/contact-center/interactions/[id]/transcription/route.js`
- `app/api/contact-center/interactions/[id]/consult/route.js`
- `app/api/contact-center/interactions/by-call-control-id/consult/route.js`
- `app/api/contact-center/interactions/[id]/transfer/route.js`
- `app/api/contact-center/interactions/by-call-control-id/transfer/route.js`
- `app/api/contact-center/calls/supervise/route.js`
- `app/api/contact-center/calls/[callControlId]/switch-supervisor-role/route.js`

Topic usage:

- interaction lifecycle -> `contact-center.interactions`
- wrap-up -> `contact-center.wrapup`
- transfer -> `contact-center.transfer`
- consult -> `contact-center.consult`
- supervision -> `contact-center.supervision`

### Phase D: Voice and Telnyx media

Files:

- `app/api/voice/webhook/incoming/[flowId]/route.js`
- `lib/voice-flow-engine.js`
- `app/api/voice/streaming/ws-handler.js`
- `app/api/voice/call-action/route.js`
- `app/api/voice/calls/[callControlId]/state/route.js`
- `app/api/voice/recordings/[id]/transcribe/route.js`

Topic usage:

- flow/webhook/call-control -> `voice.*`
- provider/STT/media/WebSocket -> `telnyx.*`

### Phase E: Agent Assist

Files:

- `lib/agent-assist/workflow-analyzer.js`
- `lib/agent-assist/translation-service.js`
- `lib/agent-assist/ai-handoff-processor.js`
- `app/api/agent-assist/workflow/analyze/route.js`
- `app/api/agent-assist/workflow/generate-suggestion/route.js`
- `app/api/agent-assist/workflow/start/route.js`
- `app/api/agent-assist/workflow/session/route.js`
- `app/api/agent-assist/workflow/save-history/route.js`

Topic usage:

- workflow -> `agent-assist.workflow`
- suggestions -> `agent-assist.suggestions`
- translation -> `agent-assist.translation`
- handoff -> `agent-assist.handoff`
- model/provider calls -> `agent-assist.llm`

### Phase F: Outbound Dialer

Files:

- `lib/outbound-dialer/runner.js`
- `lib/outbound-dialer/agent-campaigns.js`
- `app/api/contact-center/outbound-dialer/**/route.js`

Topic usage:

- runner -> `outbound.runner`
- campaign CRUD/config -> `outbound.campaigns`
- start/stop/pause/resume -> `outbound.execution`
- imports -> `outbound.imports`
- live calls -> `outbound.live-calls`

### Phase G: Supervisor, notifications and frontend cleanup

Files:

- `app/(portal)/supervisor/monitor/page.jsx`
- `lib/contact-center/stats-aggregator.js`
- `lib/contact-center/call-metrics-tracker.js`
- `lib/contact-center/call-summary.js`
- `lib/telnyx-insights.js`
- `lib/email-notifications.js`
- `lib/push-notifications.js`
- `components/contact-center/*.jsx`

Topic usage:

- supervisor monitor/dashboard/metrics/reports/insights -> `supervisor.*`
- email/push -> `notifications.*`
- browser telemetry only if endpoint exists -> `frontend.*`

---

## 10. Tests to Add or Update

### 10.1 Topic catalog contract test

Create:

- `tests/logging-topic-catalog.test.mjs`

Assertions:

- exactly or at most 10 groups unless test is intentionally updated
- at most 50 leaf topics
- every group has at least one topic; most groups should have about 3-5 topics, but `contact-center` may have more because it is a broad product domain
- every topic id starts with its group id
- topic IDs are unique
- labels/descriptions exist
- default levels are valid pino levels

### 10.2 Runtime config inheritance test

Modify:

- `tests/pino-logger-foundation.test.mjs`
- `tests/logger-runtime-config.test.mjs`

Assertions:

- parent `contact-center = debug` allows `contact-center.routing` debug events
- exact `contact-center.routing = error` overrides parent `contact-center = debug`
- parent `frontend = false` disables `frontend.agent-desktop`
- exact `frontend.agent-desktop = true` can override parent disabled state if that is the desired behavior

Note: current `isTopicEnabled()` returns parent setting if exact topic is absent, and exact topic wins. Preserve this.

### 10.3 Settings UI group controls test

Modify:

- `tests/admin-logging-ui.test.mjs`

Assertions:

- `SettingsView` receives `topicGroups`, not only flat `topics`
- page renders `logging-topic-groups-list`
- group rows/cards have group level controls
- topic rows have override/inherit controls
- old independently scrollable behavior remains

### 10.4 Filter UI grouped multi-select test

Modify:

- `tests/logging-startup-polish.test.mjs`

Assertions:

- flat `TopicMultiSelect` is replaced or enhanced as grouped selector
- filter dropdown includes group checkbox behavior
- group selection expands into repeated `topics` query params
- `All topics` remains available
- legacy single `topic` input does not return

---

## 11. Rollout Recommendation

Recommended PR sequence:

1. **PR 1: Topic catalog and grouped Admin UI**
   - No broad logging migration yet.
   - Establish UX and contract tests first.

2. **PR 2: Contact Center core logging helper + routing/status/timeout**
   - Highest operational value.
   - Uses `contact-center.status`, `contact-center.routing`, `contact-center.timeout`, `contact-center.reservations`.

3. **PR 3: Interactions/transfer/consult/supervision**
   - Most useful during live call incidents.

4. **PR 4: Voice Flow and Telnyx media/provider logs**
   - Separate business Voice Flow from provider/media noise.

5. **PR 5: Agent Assist and AI provider logging**
   - Strong redaction discipline for model/provider responses.

6. **PR 6: Outbound Dialer**
   - Runner/execution first, CRUD/imports second.

7. **PR 7: Supervisor, notifications, frontend cleanup**
   - Clean up remaining UI console noise and add optional client telemetry only if needed.

Do not deploy/restart production automatically after these PRs unless explicitly requested.

---

## 12. Open Decisions

1. Should any group be split when it grows beyond five topics?
   - Recommendation: only split if the resulting topic IDs remain two-level and the split reflects a real operator mental model. Do not create third-level IDs just to keep every group at five topics.

2. Should group selection in Filters be represented only as expanded child topics, or should APIs accept `topicGroups`?
   - Recommendation: start with expanded child topics to avoid backend/API churn.

3. Should legacy topics appear in the standard groups or in a separate `Legacy` section?
   - Recommendation: hide them from primary Settings, but allow historical filter matching by including them in an `Advanced / Legacy topics` collapsed section.

4. Should browser frontend logs be sent to server-side JSONL?
   - Recommendation: not by default. Use `frontend.*` only for selected operational telemetry, not routine React debug traces.

---

## 13. Definition of Done

The topic grouping work is complete when:

- The app has a single canonical topic catalog.
- The catalog contains about 10 groups and no more than 50 leaf topics.
- Runtime defaults are derived from the catalog.
- Settings page allows group-level level/enabled configuration.
- Settings page allows individual topic overrides and inheritance reset.
- Live/Files topic filter displays groups and supports selecting whole groups or individual topics.
- Existing repeated `topics` query behavior continues to work for logs and SSE.
- Tests enforce topic count, grouping, inheritance, Settings UI, and filter UI.
- The first migrated Contact Center logs use the catalog and do not introduce topic sprawl.
