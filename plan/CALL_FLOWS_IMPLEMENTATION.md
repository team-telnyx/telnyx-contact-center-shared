# Call Flows Implementation Plan

## Overview

Implement a call flows editor in the contact center app, similar to the demo portal, with support for multiple active flows. Each flow will have its own Telnyx Voice Application with a unique webhook URL, and phone numbers can be assigned to flows.

## Key Differences from Demo Portal

1. **No `is_default` field** - Multiple flows can be active simultaneously
2. **Individual Voice Applications** - Each flow has its own Telnyx Call Control Application
3. **Phone Number Assignment** - Phone numbers can be assigned to specific flows
4. **Voice Application Lifecycle** - Voice applications are created/deleted with flows
5. **Unique Webhook URLs** - Each flow has its own webhook endpoint

## Database Schema

### Modified `voice_flows` Table

```sql
CREATE TABLE IF NOT EXISTS voice_flows (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,

  -- Telnyx Voice Application integration
  telnyx_voice_app_id TEXT, -- Telnyx Call Control Application ID
  webhook_url TEXT, -- Unique webhook URL for this flow

  -- Flow definition
  nodes JSONB NOT NULL,
  edges JSONB NOT NULL,
  variables JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_flows_username ON voice_flows (username);
CREATE INDEX IF NOT EXISTS idx_voice_flows_telnyx_app_id ON voice_flows (telnyx_voice_app_id);
```

### New `voice_flow_phone_numbers` Table

```sql
CREATE TABLE IF NOT EXISTS voice_flow_phone_numbers (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES voice_flows(id) ON DELETE CASCADE,
  phone_number_id TEXT NOT NULL, -- Telnyx phone number ID
  phone_number TEXT NOT NULL, -- E.164 format (e.g., +13125551234)
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_by TEXT, -- Username who assigned the number
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(flow_id, phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_flow_phone_numbers_flow_id ON voice_flow_phone_numbers (flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_phone_numbers_phone_number_id ON voice_flow_phone_numbers (phone_number_id);
```

### Existing `voice_flow_executions` Table (unchanged)

```sql
CREATE TABLE IF NOT EXISTS voice_flow_executions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  call_control_id TEXT NOT NULL,
  current_node_id TEXT,
  variables JSONB DEFAULT '{}',
  execution_history JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_voice_flow_executions_call_control_id ON voice_flow_executions (call_control_id);
CREATE INDEX IF NOT EXISTS idx_voice_flow_executions_flow_id ON voice_flow_executions (flow_id);
```

## API Routes Structure

### 1. Flow Management Routes

#### `GET /api/voice/flows`

- **Purpose**: List all flows for authenticated user
- **Query Params**: `page`, `pageSize`, `name` (filter)
- **Returns**: List of flows with voice app IDs and assigned phone numbers

#### `POST /api/voice/flows`

- **Purpose**: Create new flow
- **Body**: `{ name, description, nodes, edges, variables, metadata }`
- **Process**:
  1. Creates flow in DB
  2. Creates Telnyx Voice Application
  3. Generates unique webhook URL: `/api/voice/webhook/incoming/[flowId]`
- **Returns**: Flow with `telnyx_voice_app_id` and `webhook_url`

#### `GET /api/voice/flows/[id]`

- **Purpose**: Get single flow details
- **Returns**: Flow details including voice app info and assigned numbers

#### `PUT /api/voice/flows/[id]`

- **Purpose**: Update flow
- **Body**: `{ name, description, nodes, edges, variables, metadata }`
- **Process**: Updates flow in DB and Telnyx Voice Application webhook URL if needed

#### `DELETE /api/voice/flows/[id]`

- **Purpose**: Delete flow
- **Process**:
  1. Unassigns all phone numbers from the voice application
  2. Deletes Telnyx Voice Application
  3. Deletes flow from DB (cascades to phone number assignments)

### 2. Phone Number Assignment Routes

#### `GET /api/voice/flows/[id]/phone-numbers`

- **Purpose**: List assigned phone numbers for a flow
- **Returns**: Array of phone numbers assigned to this flow

#### `POST /api/voice/flows/[id]/phone-numbers`

- **Purpose**: Assign phone number to flow
- **Body**: `{ phone_number_id }`
- **Process**:
  1. Assigns phone number to Telnyx Voice Application
  2. Creates record in `voice_flow_phone_numbers` table
- **Returns**: Assignment details

#### `DELETE /api/voice/flows/[id]/phone-numbers/[phoneNumberId]`

- **Purpose**: Unassign phone number from flow
- **Process**:
  1. Unassigns phone number from Telnyx Voice Application
  2. Deletes record from `voice_flow_phone_numbers` table
- **Returns**: Success confirmation

### 3. Webhook Route

#### `POST /api/voice/webhook/incoming/[flowId]`

- **Purpose**: Handle Telnyx webhook events for flow execution
- **Implementation**: Same as demo portal webhook handler
- **Routes**: Based on `flowId` in URL

### 4. Voice Application Management Routes

#### `GET /api/voice/flows/[id]/voice-app`

- **Purpose**: Get voice application details
- **Returns**: Telnyx Voice Application details

#### `POST /api/voice/flows/[id]/voice-app/regenerate`

- **Purpose**: Regenerate webhook URL
- **Process**: Updates webhook URL in Telnyx Voice Application and DB

## Implementation Details

### 1. Voice Application Creation

When a flow is created:

1. Generate unique webhook URL: `${BASE_URL}/api/voice/webhook/incoming/${flowId}`
2. Create Telnyx Call Control Application via API:
   ```javascript
   POST /v2/call_control_applications
   {
     "application_name": `Call Flow: ${flowName}`,
     "webhook_event_url": webhookUrl,
     "webhook_event_failover_url": null,
     "webhook_api_version": "2"
   }
   ```
3. Store `telnyx_voice_app_id` and `webhook_url` in flow record

### 2. Phone Number Assignment

When assigning a phone number:

1. Update Telnyx phone number to use the flow's voice application:
   ```javascript
   PATCH /v2/phone_numbers/{phone_number_id}
   {
     "call_control_application_id": flow.telnyx_voice_app_id
   }
   ```
2. Create record in `voice_flow_phone_numbers` table

### 3. Flow Deletion

When deleting a flow:

1. Get all assigned phone numbers from `voice_flow_phone_numbers`
2. For each phone number:
   - Unassign from voice application: `PATCH /v2/phone_numbers/{id}` with `call_control_application_id: null`
3. Delete Telnyx Voice Application: `DELETE /v2/call_control_applications/{id}`
4. Delete flow from DB (cascades to phone number assignments)

### 4. Database Library Functions

**File**: `lib/pgdb-voice-flows.js`

Functions:

- `createFlow(username, flowData)` - Creates flow and voice app
- `getFlowById(id, username)` - Gets flow with phone numbers
- `listFlows(username, filters, pagination)` - Lists flows
- `updateFlow(id, username, updates)` - Updates flow
- `deleteFlow(id, username)` - Deletes flow and voice app
- `assignPhoneNumber(flowId, phoneNumberId, phoneNumber, assignedBy)` - Assigns number
- `unassignPhoneNumber(flowId, phoneNumberId)` - Unassigns number
- `getFlowPhoneNumbers(flowId)` - Gets assigned numbers

### 5. Telnyx API Integration

**File**: `lib/telnyx-voice-apps.js`

Functions:

- `createVoiceApplication(name, webhookUrl)` - Creates voice app
- `updateVoiceApplication(appId, updates)` - Updates voice app
- `deleteVoiceApplication(appId)` - Deletes voice app
- `assignPhoneNumberToApp(phoneNumberId, appId)` - Assigns number
- `unassignPhoneNumberFromApp(phoneNumberId)` - Unassigns number

## UI Components

### Menu Addition

Add to `config/menu.jsx` in ADMIN group:

```javascript
{
  title: "Call Flows",
  url: "/admin/call-flows",
  icon: IconGitBranch,
  role_access: ["admin", "owner"],
}
```

### Pages to Create

1. **`app/(portal)/admin/call-flows/page.jsx`**

   - List all flows
   - Create new flow button
   - Edit/Delete actions
   - Show assigned phone numbers count

2. **`app/(portal)/admin/call-flows/[id]/page.jsx`**
   - Flow editor (copy from demo portal)
   - Phone number assignment UI
   - Voice application status display

## Migration Notes

For existing databases:

1. Add `telnyx_voice_app_id` and `webhook_url` columns to `voice_flows`
2. Remove `is_default` column (or keep for backward compatibility but ignore)
3. Create `voice_flow_phone_numbers` table

## Testing Checklist

- [ ] Create new flow with voice application
- [ ] Assign phone number to flow
- [ ] Unassign phone number from flow
- [ ] Update flow configuration
- [ ] Delete flow (should unassign numbers and delete voice app)
- [ ] Test webhook execution with incoming call
- [ ] Verify multiple flows can be active simultaneously
- [ ] Test phone number assignment UI
- [ ] Verify voice application creation/deletion
