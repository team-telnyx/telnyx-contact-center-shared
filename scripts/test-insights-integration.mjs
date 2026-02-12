#!/usr/bin/env node
/**
 * Test script for AI to Agent Workflow Handoff - Insights Integration
 * 
 * Tests the full flow:
 * 1. Create Insight Group
 * 2. Create 3 Insights (slots, summary, sentiment)
 * 3. Assign insights to group
 * 4. Update AI Assistant with insight_settings
 * 5. Cleanup (optional)
 * 
 * Usage:
 *   node scripts/test-insights-integration.mjs [--cleanup] [--assistant-id <id>]
 * 
 * Environment:
 *   TELNYX_API_KEY - Required
 *   TELNYX_WEBHOOK_BASE_URL or NEXTAUTH_URL - For webhook URL
 */

import 'dotenv/config';

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const WEBHOOK_BASE_URL = process.env.TELNYX_WEBHOOK_BASE_URL || process.env.NEXTAUTH_URL || 'https://example.com';
const WEBHOOK_URL = `${WEBHOOK_BASE_URL}/api/webhooks/telnyx/conversation-insights`;

if (!TELNYX_API_KEY) {
  console.error('❌ TELNYX_API_KEY is required');
  process.exit(1);
}

const API_BASE = 'https://api.telnyx.com/v2';

// Parse args
const args = process.argv.slice(2);
const shouldCleanup = args.includes('--cleanup');
const assistantIdIndex = args.indexOf('--assistant-id');
const testAssistantId = assistantIdIndex !== -1 ? args[assistantIdIndex + 1] : null;

// Test data - simulating a workflow with slots
const TEST_WORKFLOW = {
  name: 'Test Healthcare Intake',
  description: 'Test workflow for AI handoff integration',
  slots: [
    { slot_name: 'patient_name', slot_type: 'text', label: 'Patient Name', description: 'Full name of the patient' },
    { slot_name: 'date_of_birth', slot_type: 'date', label: 'Date of Birth', description: 'Patient date of birth' },
    { slot_name: 'symptoms', slot_type: 'text', label: 'Symptoms', description: 'Main symptoms described' },
    { slot_name: 'urgency_level', slot_type: 'enum', label: 'Urgency Level', hints: ['low', 'medium', 'high', 'critical'] },
  ],
  stages: [
    { name: 'Greeting', items: [] },
    { name: 'Patient Information', items: ['patient_name', 'date_of_birth'] },
    { name: 'Medical Assessment', items: ['symptoms', 'urgency_level'] },
  ]
};

// Store created resources for cleanup
const createdResources = {
  insightGroupId: null,
  insightIds: [],
};

// ============ API Helpers ============

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

// ============ Schema Generators ============

function getValueSchemaForType(slotType) {
  switch (slotType) {
    case 'email': return { type: 'string', format: 'email' };
    case 'phone': return { type: 'string', pattern: '^\\+?[0-9\\s\\-()]+$' };
    case 'number': case 'currency': return { type: 'number' };
    case 'integer': return { type: 'integer' };
    case 'boolean': return { type: 'boolean' };
    case 'date': return { type: 'string', format: 'date' };
    case 'datetime': return { type: 'string', format: 'date-time' };
    default: return { type: 'string' };
  }
}

function generateSlotsSchema(slots) {
  const slotProperties = {};
  
  for (const slot of slots) {
    const valueSchema = slot.slot_type === 'enum' && slot.hints?.length
      ? { type: 'string', enum: slot.hints }
      : getValueSchemaForType(slot.slot_type);
    
    slotProperties[slot.slot_name] = {
      type: 'object',
      properties: {
        value: valueSchema,
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        source_utterance: { type: 'string' }
      },
      description: slot.description || slot.label
    };
  }
  
  return {
    type: 'object',
    properties: {
      slots: {
        type: 'object',
        properties: slotProperties,
        description: 'Extracted slot values from the conversation'
      },
      completed_stages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of stages that were fully completed'
      }
    },
    required: ['slots']
  };
}

function generateSlotsInstructions(workflow) {
  let instructions = `Analyze the conversation and extract the following information for a ${workflow.name} workflow.\n\n`;
  instructions += `## Slots to Extract\n\n`;
  
  for (const slot of workflow.slots) {
    instructions += `- **${slot.slot_name}** (${slot.slot_type}): ${slot.label}`;
    if (slot.description) instructions += ` - ${slot.description}`;
    if (slot.hints?.length) instructions += `\n  Valid values: ${slot.hints.join(', ')}`;
    instructions += `\n`;
  }
  
  instructions += `\n## Instructions\n`;
  instructions += `- For each slot, extract the value if clearly stated in conversation\n`;
  instructions += `- Set value to null if information was not provided or unclear\n`;
  instructions += `- Confidence: 1.0 = explicitly stated, 0.7-0.9 = inferred, <0.7 = uncertain\n`;
  instructions += `- Include the exact source utterance where the value was mentioned\n`;
  
  return instructions;
}

function generateSummaryInstructions(workflow) {
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

function generateSentimentInstructions(workflow) {
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

// ============ Test Functions ============

async function testCreateInsightGroup() {
  console.log('\n📦 Creating Insight Group...');
  
  const response = await telnyxFetch('/ai/conversations/insight-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `WF: ${TEST_WORKFLOW.name}`,
      description: `Insights for workflow: ${TEST_WORKFLOW.name}`,
      webhook: WEBHOOK_URL,
    }),
  });
  
  const groupId = response.data?.id;
  createdResources.insightGroupId = groupId;
  
  console.log(`   ✅ Created Insight Group: ${groupId}`);
  console.log(`   Webhook URL: ${WEBHOOK_URL}`);
  
  return groupId;
}

async function testCreateInsight(name, instructions, jsonSchema = null) {
  console.log(`\n📝 Creating Insight: ${name}...`);
  
  const payload = {
    name: `${TEST_WORKFLOW.name} - ${name}`,
    instructions,
  };
  
  if (jsonSchema) {
    payload.json_schema = jsonSchema;
  }
  
  const response = await telnyxFetch('/ai/conversations/insights', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  
  const insightId = response.data?.id;
  createdResources.insightIds.push(insightId);
  
  console.log(`   ✅ Created Insight: ${insightId}`);
  if (jsonSchema) {
    console.log(`   Schema properties: ${Object.keys(jsonSchema.properties || {}).join(', ')}`);
  }
  
  return insightId;
}

async function testAssignInsightToGroup(insightId, groupId) {
  console.log(`\n🔗 Assigning Insight ${insightId.slice(0, 8)}... to Group...`);
  
  await telnyxFetch(`/ai/conversations/insight-groups/${groupId}/insights/${insightId}/assign`, {
    method: 'POST',
  });
  
  console.log(`   ✅ Assigned successfully`);
}

async function testGetInsightGroup(groupId) {
  console.log(`\n🔍 Verifying Insight Group...`);
  
  const response = await telnyxFetch(`/ai/conversations/insight-groups/${groupId}`);
  
  const group = response.data;
  console.log(`   Name: ${group.name}`);
  console.log(`   Webhook: ${group.webhook}`);
  console.log(`   Insights count: ${group.insights?.length || 0}`);
  
  if (group.insights?.length) {
    for (const insight of group.insights) {
      console.log(`   - ${insight.name} (${insight.id})`);
    }
  }
  
  return group;
}

async function testUpdateAssistant(assistantId, insightGroupId) {
  console.log(`\n🤖 Updating AI Assistant with insight_settings...`);
  
  // First get current assistant
  const getResponse = await telnyxFetch(`/ai/assistants/${assistantId}`);
  const assistant = getResponse.data;
  
  console.log(`   Assistant: ${assistant.name}`);
  console.log(`   Current insight_settings: ${JSON.stringify(assistant.insight_settings || 'none')}`);
  
  // Update with insight group
  const updateResponse = await telnyxFetch(`/ai/assistants/${assistantId}`, {
    method: 'POST',  // Telnyx uses POST for updates
    body: JSON.stringify({
      insight_settings: {
        insight_group_id: insightGroupId,
      },
    }),
  });
  
  console.log(`   ✅ Updated assistant with insight_group_id: ${insightGroupId}`);
  
  return updateResponse.data;
}

async function testCleanup() {
  console.log('\n🧹 Cleaning up test resources...');
  
  // Delete insights
  for (const insightId of createdResources.insightIds) {
    try {
      await telnyxFetch(`/ai/conversations/insights/${insightId}`, { method: 'DELETE' });
      console.log(`   ✅ Deleted insight: ${insightId}`);
    } catch (err) {
      console.log(`   ⚠️ Failed to delete insight ${insightId}: ${err.message}`);
    }
  }
  
  // Delete insight group
  if (createdResources.insightGroupId) {
    try {
      await telnyxFetch(`/ai/conversations/insight-groups/${createdResources.insightGroupId}`, { method: 'DELETE' });
      console.log(`   ✅ Deleted insight group: ${createdResources.insightGroupId}`);
    } catch (err) {
      console.log(`   ⚠️ Failed to delete group: ${err.message}`);
    }
  }
}

// ============ Main ============

async function main() {
  console.log('🧪 AI to Agent Workflow Handoff - Insights Integration Test');
  console.log('='.repeat(60));
  console.log(`\nWebhook URL: ${WEBHOOK_URL}`);
  console.log(`Test Assistant ID: ${testAssistantId || 'not provided (will skip assistant update)'}`);
  console.log(`Cleanup after test: ${shouldCleanup}`);
  
  try {
    // Step 1: Create Insight Group
    const groupId = await testCreateInsightGroup();
    
    // Step 2: Create Slots Insight
    const slotsSchema = generateSlotsSchema(TEST_WORKFLOW.slots);
    const slotsInstructions = generateSlotsInstructions(TEST_WORKFLOW);
    const slotsInsightId = await testCreateInsight('Slots', slotsInstructions, slotsSchema);
    
    // Step 3: Create Summary Insight
    const summaryInstructions = generateSummaryInstructions(TEST_WORKFLOW);
    const summaryInsightId = await testCreateInsight('Summary', summaryInstructions);
    
    // Step 4: Create Sentiment Insight
    const sentimentInstructions = generateSentimentInstructions(TEST_WORKFLOW);
    const sentimentInsightId = await testCreateInsight('Sentiment', sentimentInstructions);
    
    // Step 5: Assign all insights to group
    await testAssignInsightToGroup(slotsInsightId, groupId);
    await testAssignInsightToGroup(summaryInsightId, groupId);
    await testAssignInsightToGroup(sentimentInsightId, groupId);
    
    // Step 6: Verify group
    await testGetInsightGroup(groupId);
    
    // Step 7: Update AI Assistant (if provided)
    if (testAssistantId) {
      await testUpdateAssistant(testAssistantId, groupId);
    } else {
      console.log('\n⏭️ Skipping assistant update (no --assistant-id provided)');
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL TESTS PASSED!');
    console.log('='.repeat(60));
    
    console.log('\n📋 Created Resources:');
    console.log(`   Insight Group ID: ${createdResources.insightGroupId}`);
    console.log(`   Slots Insight ID: ${slotsInsightId}`);
    console.log(`   Summary Insight ID: ${summaryInsightId}`);
    console.log(`   Sentiment Insight ID: ${sentimentInsightId}`);
    
    // Cleanup if requested
    if (shouldCleanup) {
      await testCleanup();
    } else {
      console.log('\n💡 Run with --cleanup to delete test resources');
    }
    
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    
    if (shouldCleanup) {
      await testCleanup();
    }
    
    process.exit(1);
  }
}

main();
