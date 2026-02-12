#!/usr/bin/env node
/**
 * Create AI Assistant with Insights for existing workflow
 * 
 * Uses workflow from database and creates:
 * 1. AI Assistant (with telephony enabled in 2-step process)
 * 2. Insight Group with webhook
 * 3. Three insights: Summary, Sentiment, Slots
 * 4. Links everything together
 * 
 * Usage:
 *   TELNYX_API_KEY="..." node scripts/create-assistant-for-workflow.mjs
 * 
 * Options:
 *   --cleanup    Delete created resources after test
 *   --no-db      Don't update database with IDs
 */

import 'dotenv/config';
import pg from 'pg';

// Ensure we use the correct API key (not global shell var)
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const API_BASE = 'https://api.telnyx.com/v2';

// Workflow ID to use (Healthcare Intake - Air Ambulance)
const WORKFLOW_ID = '63c59d29-21c4-4894-8607-2813818d19a7';

// Database config
const DB_CONFIG = {
  host: '10.10.10.100',
  port: 5432,
  database: 'contact_center',
  user: 'contact_center',
  password: 'KLM89_XS045_OP76GF27SD'
};

// Webhook URL
const WEBHOOK_BASE_URL = process.env.TELNYX_WEBHOOK_BASE_URL || process.env.NEXTAUTH_URL || 'https://api.tokaj.synology.me';
const WEBHOOK_URL = `${WEBHOOK_BASE_URL}/api/webhooks/telnyx/conversation-insights`;

// Parse args
const args = process.argv.slice(2);
const shouldCleanup = args.includes('--cleanup');
const skipDb = args.includes('--no-db');

// Created resources
const created = {
  assistantId: null,
  insightGroupId: null,
  summaryInsightId: null,
  sentimentInsightId: null,
  slotsInsightId: null
};

// ============ API Helper ============

async function telnyxFetch(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  
  if (!response.ok) {
    throw new Error(`API Error ${response.status}: ${JSON.stringify(data)}`);
  }
  
  return data;
}

// ============ Database Helper ============

async function getWorkflowFromDb(workflowId) {
  const pool = new pg.Pool(DB_CONFIG);
  try {
    // Get workflow
    const { rows: [workflow] } = await pool.query(
      `SELECT * FROM aa_workflows WHERE id = $1`, [workflowId]
    );
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

    // Get stages
    const { rows: stages } = await pool.query(
      `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`, [workflowId]
    );

    // Get items
    const stageIds = stages.map(s => s.id);
    const { rows: items } = await pool.query(
      `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`, [stageIds]
    );

    // Group items by stage
    const itemsByStage = {};
    for (const item of items) {
      if (!itemsByStage[item.stage_id]) itemsByStage[item.stage_id] = [];
      itemsByStage[item.stage_id].push(item);
    }

    // Attach items to stages
    for (const stage of stages) {
      stage.items = itemsByStage[stage.id] || [];
    }

    workflow.stages = stages;
    
    // Extract slots
    workflow.slots = items.filter(i => i.type === 'slot' && i.slot_name);
    
    return workflow;
  } finally {
    await pool.end();
  }
}

async function updateWorkflowInDb(workflowId, updates) {
  if (skipDb) {
    console.log('   (Skipping DB update - --no-db flag)');
    return;
  }
  
  const pool = new pg.Pool(DB_CONFIG);
  try {
    const setClauses = [];
    const values = [];
    let i = 1;
    
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = $${i++}`);
      values.push(value);
    }
    values.push(workflowId);
    
    await pool.query(
      `UPDATE aa_workflows SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${i}`,
      values
    );
    console.log('   ✅ Database updated');
  } finally {
    await pool.end();
  }
}

// ============ Instruction Generators ============

function generateAssistantInstructions(workflow) {
  let instructions = `# ${workflow.name}

${workflow.description || 'AI Assistant for handling calls.'}

## Your Role
You are a professional and efficient AI assistant helping callers with medical transport requests. Your goal is to collect necessary information accurately while being empathetic and helpful.

## Information to Collect

`;

  for (const stage of workflow.stages) {
    instructions += `### ${stage.name}\n`;
    if (stage.description) instructions += `${stage.description}\n`;
    instructions += '\n';
    
    for (const item of stage.items) {
      if (item.type === 'slot' && item.slot_name) {
        instructions += `- **${item.label}** (${item.slot_name})\n`;
      } else if (item.type === 'question') {
        instructions += `- Ask: ${item.label}\n`;
      } else if (item.type === 'action') {
        instructions += `- Do: ${item.label}\n`;
      }
    }
    instructions += '\n';
  }

  instructions += `## Guidelines
- Be professional and efficient - time is critical in medical transport
- Confirm spelling of names and verify numbers by reading them back
- If caller wants to speak to a human, acknowledge and transfer immediately
- Use clear, simple language
- Be empathetic - callers may be stressed about patient conditions

## Transfer
If the caller requests a human agent at any point, say: "Of course, I'll connect you with a dispatcher right away. I'll share the information we've collected so far."
`;

  return instructions;
}

function generateSummaryInstructions(workflow) {
  return `You are analyzing a conversation from the "${workflow.name}" workflow.

## Task
Create a concise summary for a dispatcher who will continue handling this request.

## Requirements
- Use **Markdown formatting**
- Focus on critical information: patient details, transport requirements, urgency
- Note any special equipment or precautions needed
- Keep under 250 words

## Output Format

## Call Summary

**Request Type:** [New transport / Status check / Other]

**Caller:** [Name] from [Facility], [Department]
**Callback:** [Phone number]

**Patient:** [Name], DOB: [Date], [Gender], [Weight]

**Transport:**
- **From:** [Pickup facility and location]
- **To:** [Destination facility and department]
- **Reason:** [Medical reason for transport]

**Equipment/Requirements:**
- [List any IVs, special equipment, accompanying persons]

**Safety Notes:**
- [Any weather declines, other aircraft, isolation precautions]

**Status:** [What was completed / What's pending]

**Agent Notes:** [Any issues or important context]`;
}

function generateSentimentInstructions(workflow) {
  return `You are analyzing sentiment in a "${workflow.name}" conversation.

## Task
Assess the caller's emotional state to help the dispatcher handle the conversation appropriately.

## Requirements
- Use **Markdown formatting**
- Focus on urgency and stress levels (medical context)
- Provide actionable guidance for the dispatcher

## Output Format

## Sentiment Analysis

**Overall:** [Calm/Concerned/Stressed/Urgent] (Score: X/10)

**Urgency Level:** [Routine / Time-sensitive / Urgent / Critical]

**Emotional State:**
| Phase | State | Notes |
|-------|-------|-------|
| Start | [emoji + state] | [observation] |
| During | [emoji + state] | [observation] |
| End | [emoji + state] | [observation] |

**Key Indicators:**
- 🔴 **Stress signals:** [What indicated stress or urgency]
- 🟢 **Positive signs:** [What indicated calm or satisfaction]

**Dispatcher Tips:**
- **Tone:** [Recommended approach]
- **Priority:** [What to address first]
- **Caution:** [What to be careful about]`;
}

function generateSlotsInstructions(workflow) {
  let instructions = `You are extracting data from a "${workflow.name}" conversation.

## Task
Extract all slot values mentioned during the call for handoff to a human dispatcher.

## Slots to Extract

`;

  for (const slot of workflow.slots) {
    instructions += `### ${slot.slot_name}
- **Label:** ${slot.label}
- **Type:** ${slot.slot_type || 'text'}
`;
    if (slot.hints?.length) {
      instructions += `- **Keywords:** ${slot.hints.join(', ')}\n`;
    }
    instructions += '\n';
  }

  instructions += `## Rules
1. Only extract explicitly stated values - do not guess
2. Confidence scoring:
   - 1.0 = Clearly stated and confirmed
   - 0.8-0.9 = Stated but not confirmed
   - 0.6-0.7 = Implied or partial
   - Below 0.6 = Do not include
3. Include source utterance for each extracted value
4. Set value to null if not mentioned

## Output Format
{
  "slots": {
`;

  for (const slot of workflow.slots) {
    instructions += `    "${slot.slot_name}": { "value": <extracted or null>, "confidence": <0-1>, "source_utterance": "<quote>" },\n`;
  }

  instructions += `  },
  "completed_stages": ["<stage names where all slots were collected>"]
}`;

  return instructions;
}

function generateSlotsSchema(workflow) {
  const slotProperties = {};
  
  for (const slot of workflow.slots) {
    let valueSchema = { type: 'string' };
    
    switch (slot.slot_type) {
      case 'phone': valueSchema = { type: 'string', pattern: '^\\+?[0-9\\s\\-()]+$' }; break;
      case 'date': valueSchema = { type: 'string', format: 'date' }; break;
      case 'number': valueSchema = { type: 'number' }; break;
      case 'boolean': valueSchema = { type: 'boolean' }; break;
    }
    
    slotProperties[slot.slot_name] = {
      type: 'object',
      properties: {
        value: { ...valueSchema, nullable: true },
        confidence: { type: 'number', minimum: 0, maximum: 1, nullable: true },
        source_utterance: { type: 'string', nullable: true }
      },
      description: slot.label
    };
  }
  
  return {
    type: 'object',
    properties: {
      slots: { type: 'object', properties: slotProperties },
      completed_stages: { type: 'array', items: { type: 'string' } }
    },
    required: ['slots']
  };
}

// ============ Main Steps ============

async function createAssistant(workflow) {
  console.log('\n🤖 Step 1: Creating AI Assistant...');
  
  const instructions = generateAssistantInstructions(workflow);
  
  // Step 1a: Create assistant (basic)
  const response = await telnyxFetch('/ai/assistants', {
    method: 'POST',
    body: JSON.stringify({
      name: workflow.name,
      model: 'openai/gpt-4o',
      instructions,
      greeting: `Hello, thank you for calling ${workflow.name.replace(' (Air Ambulance)', '')}. I'm an AI assistant and I'll help collect some information before connecting you with our dispatch team. May I have your name please?`,
      voice_settings: {
        voice: 'nova'
      },
      transcription: {
        model: 'telnyx_enhanced',
        language: 'en'
      }
    }),
  });
  
  const assistantId = response.id || response.data?.id;
  created.assistantId = assistantId;
  console.log(`   ✅ Created: ${assistantId}`);
  
  // Step 1b: Enable telephony with unauthenticated calls
  console.log('   Enabling telephony + unauthenticated calls...');
  
  await telnyxFetch(`/ai/assistants/${assistantId}`, {
    method: 'POST',
    body: JSON.stringify({
      telephony_settings: {
        enable: true,
        allow_unauthenticated_calls: true
      }
    }),
  });
  
  console.log('   ✅ Telephony enabled with unauthenticated calls');
  
  return assistantId;
}

async function createInsightGroup(workflow) {
  console.log('\n📦 Step 2: Creating Insight Group...');
  
  const response = await telnyxFetch('/ai/conversations/insight-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `WF: ${workflow.name}`,
      description: `Insights for ${workflow.name} workflow. Summary, Sentiment Analysis, and ${workflow.slots.length} slot extractions.`,
      webhook: WEBHOOK_URL,
    }),
  });
  
  const groupId = response.data?.id;
  created.insightGroupId = groupId;
  console.log(`   ✅ Created: ${groupId}`);
  console.log(`   Webhook: ${WEBHOOK_URL}`);
  
  return groupId;
}

async function createInsights(workflow) {
  console.log('\n📝 Step 3: Creating Insights...');
  
  // Summary
  console.log('   Creating Summary insight...');
  const summaryResp = await telnyxFetch('/ai/conversations/insights', {
    method: 'POST',
    body: JSON.stringify({
      name: `${workflow.name} - Summary`,
      instructions: generateSummaryInstructions(workflow),
    }),
  });
  created.summaryInsightId = summaryResp.data?.id;
  console.log(`   ✅ Summary: ${created.summaryInsightId}`);
  
  // Sentiment
  console.log('   Creating Sentiment insight...');
  const sentimentResp = await telnyxFetch('/ai/conversations/insights', {
    method: 'POST',
    body: JSON.stringify({
      name: `${workflow.name} - Sentiment`,
      instructions: generateSentimentInstructions(workflow),
    }),
  });
  created.sentimentInsightId = sentimentResp.data?.id;
  console.log(`   ✅ Sentiment: ${created.sentimentInsightId}`);
  
  // Slots
  console.log('   Creating Slots insight...');
  const slotsResp = await telnyxFetch('/ai/conversations/insights', {
    method: 'POST',
    body: JSON.stringify({
      name: `${workflow.name} - Slots`,
      instructions: generateSlotsInstructions(workflow),
      json_schema: generateSlotsSchema(workflow),
    }),
  });
  created.slotsInsightId = slotsResp.data?.id;
  console.log(`   ✅ Slots: ${created.slotsInsightId} (${workflow.slots.length} slots in schema)`);
}

async function assignInsightsToGroup() {
  console.log('\n🔗 Step 4: Assigning insights to group...');
  
  const insights = [
    { name: 'Summary', id: created.summaryInsightId },
    { name: 'Sentiment', id: created.sentimentInsightId },
    { name: 'Slots', id: created.slotsInsightId },
  ];
  
  for (const insight of insights) {
    await telnyxFetch(
      `/ai/conversations/insight-groups/${created.insightGroupId}/insights/${insight.id}/assign`,
      { method: 'POST' }
    );
    console.log(`   ✅ ${insight.name} assigned`);
  }
}

async function linkAssistantToInsights() {
  console.log('\n🔄 Step 5: Linking assistant to insight group...');
  
  await telnyxFetch(`/ai/assistants/${created.assistantId}`, {
    method: 'POST',
    body: JSON.stringify({
      insight_settings: {
        insight_group_id: created.insightGroupId,
      },
    }),
  });
  
  console.log(`   ✅ Assistant linked to insight group`);
}

async function verifySetup() {
  console.log('\n🔍 Step 6: Verifying setup...');
  
  // Check assistant
  const assistant = await telnyxFetch(`/ai/assistants/${created.assistantId}`);
  const a = assistant.id ? assistant : assistant.data;
  
  console.log(`\n   Assistant: ${a.name}`);
  console.log(`   - ID: ${a.id}`);
  console.log(`   - Telephony: ${a.telephony_settings?.enable ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`   - Unauth calls: ${a.telephony_settings?.allow_unauthenticated_calls ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`   - Insight Group: ${a.insight_settings?.insight_group_id || 'NOT SET'}`);
  
  // Check insight group
  const group = await telnyxFetch(`/ai/conversations/insight-groups/${created.insightGroupId}`);
  console.log(`\n   Insight Group: ${group.data.name}`);
  console.log(`   - ID: ${group.data.id}`);
  console.log(`   - Webhook: ${group.data.webhook}`);
  console.log(`   - Insights: ${group.data.insights?.length || 0}`);
  
  for (const insight of group.data.insights || []) {
    console.log(`     • ${insight.name} (${insight.json_schema ? 'JSON' : 'text'})`);
  }
  
  // Validation
  const valid = 
    a.telephony_settings?.enable &&
    a.telephony_settings?.allow_unauthenticated_calls &&
    a.insight_settings?.insight_group_id === created.insightGroupId &&
    group.data.insights?.length === 3;
  
  console.log(`\n   ${valid ? '✅ VALIDATION PASSED' : '❌ VALIDATION FAILED'}`);
  return valid;
}

async function updateDatabase(workflowId) {
  console.log('\n💾 Step 7: Updating database...');
  
  await updateWorkflowInDb(workflowId, {
    ai_assistant_id: created.assistantId,
    insight_group_id: created.insightGroupId,
    insight_slots_id: created.slotsInsightId,
    insight_summary_id: created.summaryInsightId,
    insight_sentiment_id: created.sentimentInsightId,
  });
}

async function cleanup() {
  console.log('\n🧹 Cleaning up...');
  
  if (created.insightGroupId) {
    try {
      await telnyxFetch(`/ai/conversations/insight-groups/${created.insightGroupId}`, { method: 'DELETE' });
      console.log(`   ✅ Deleted insight group`);
    } catch (e) { console.log(`   ⚠️ ${e.message}`); }
  }
  
  for (const [name, id] of [['Summary', created.summaryInsightId], ['Sentiment', created.sentimentInsightId], ['Slots', created.slotsInsightId]]) {
    if (id) {
      try {
        await telnyxFetch(`/ai/conversations/insights/${id}`, { method: 'DELETE' });
        console.log(`   ✅ Deleted ${name} insight`);
      } catch (e) { console.log(`   ⚠️ ${e.message}`); }
    }
  }
  
  if (created.assistantId) {
    try {
      await telnyxFetch(`/ai/assistants/${created.assistantId}`, { method: 'DELETE' });
      console.log(`   ✅ Deleted assistant`);
    } catch (e) { console.log(`   ⚠️ ${e.message}`); }
  }
}

// ============ Main ============

async function main() {
  console.log('═'.repeat(70));
  console.log('🏥 Create AI Assistant with Insights for Workflow');
  console.log('═'.repeat(70));
  
  console.log(`\nAPI Key: ${TELNYX_API_KEY?.slice(0, 20)}...`);
  console.log(`Workflow ID: ${WORKFLOW_ID}`);
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
  console.log(`Cleanup: ${shouldCleanup}`);
  console.log(`Update DB: ${!skipDb}`);
  
  try {
    // Load workflow from DB
    console.log('\n📋 Loading workflow from database...');
    const workflow = await getWorkflowFromDb(WORKFLOW_ID);
    console.log(`   Name: ${workflow.name}`);
    console.log(`   Stages: ${workflow.stages.length}`);
    console.log(`   Slots: ${workflow.slots.length}`);
    
    // Execute steps
    await createAssistant(workflow);
    await createInsightGroup(workflow);
    await createInsights(workflow);
    await assignInsightsToGroup();
    await linkAssistantToInsights();
    const valid = await verifySetup();
    
    if (valid && !shouldCleanup) {
      await updateDatabase(WORKFLOW_ID);
    }
    
    console.log('\n' + '═'.repeat(70));
    console.log('✅ COMPLETE');
    console.log('═'.repeat(70));
    
    console.log('\n📋 Created Resources:');
    console.log(`   Assistant: ${created.assistantId}`);
    console.log(`   Insight Group: ${created.insightGroupId}`);
    console.log(`   Summary Insight: ${created.summaryInsightId}`);
    console.log(`   Sentiment Insight: ${created.sentimentInsightId}`);
    console.log(`   Slots Insight: ${created.slotsInsightId}`);
    
    if (shouldCleanup) {
      await cleanup();
    }
    
  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
    if (shouldCleanup) await cleanup();
    process.exit(1);
  }
}

main();
