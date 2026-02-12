#!/usr/bin/env node
/**
 * Test script for AI to Agent Workflow Handoff - Full Integration
 * 
 * Tests the complete flow:
 * 1. Create a new AI Assistant
 * 2. Create Insight Group with 3 insights:
 *    - Summary (call summary with markdown)
 *    - Sentiment Analysis (sentiment with markdown)
 *    - Workflow Slots (structured JSON extraction)
 * 3. Assign all insights to the group
 * 4. Update AI Assistant with insight_settings
 * 5. Verify everything is configured correctly
 * 6. Cleanup (optional)
 * 
 * Usage:
 *   node scripts/test-insights-integration.mjs [--cleanup] [--keep-assistant]
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
const keepAssistant = args.includes('--keep-assistant');

// Test workflow definition - simulating a Healthcare Intake workflow
const TEST_WORKFLOW = {
  name: 'Test Healthcare Intake',
  description: 'AI-powered healthcare intake assistant that collects patient information before transferring to a human agent.',
  slots: [
    { 
      slot_name: 'patient_name', 
      slot_type: 'text', 
      label: 'Patient Full Name', 
      description: 'The full legal name of the patient as stated during the call'
    },
    { 
      slot_name: 'date_of_birth', 
      slot_type: 'date', 
      label: 'Date of Birth', 
      description: 'Patient date of birth in YYYY-MM-DD format'
    },
    { 
      slot_name: 'phone_number', 
      slot_type: 'phone', 
      label: 'Contact Phone', 
      description: 'Best phone number to reach the patient'
    },
    { 
      slot_name: 'symptoms', 
      slot_type: 'text', 
      label: 'Main Symptoms', 
      description: 'Primary symptoms or health concerns described by the patient'
    },
    { 
      slot_name: 'urgency_level', 
      slot_type: 'enum', 
      label: 'Urgency Level', 
      description: 'How urgent is the medical need',
      hints: ['routine', 'soon', 'urgent', 'emergency']
    },
    {
      slot_name: 'insurance_provider',
      slot_type: 'text',
      label: 'Insurance Provider',
      description: 'Name of the health insurance company if mentioned'
    }
  ],
  stages: [
    { name: 'Greeting', description: 'Initial greeting and purpose identification' },
    { name: 'Patient Identification', description: 'Collect patient name and DOB' },
    { name: 'Contact Information', description: 'Verify contact phone number' },
    { name: 'Medical Assessment', description: 'Understand symptoms and urgency' },
    { name: 'Insurance Verification', description: 'Collect insurance information if available' }
  ]
};

// Store created resources for cleanup
const createdResources = {
  assistantId: null,
  insightGroupId: null,
  insightIds: {
    summary: null,
    sentiment: null,
    slots: null
  }
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

// ============ Insight Instructions Generators ============

/**
 * Generate instructions for Call Summary insight
 */
function generateSummaryInstructions(workflow) {
  return `You are analyzing a conversation from the "${workflow.name}" workflow.

## Your Task
Create a concise, actionable summary of this conversation for a contact center agent who will continue the call after transfer from the AI assistant.

## Requirements
- Use **Markdown formatting** for clear readability
- Focus on information the human agent needs to continue the conversation effectively
- Highlight any commitments made by the AI or requests from the caller
- Note the caller's primary concern and emotional state
- Keep the summary under 200 words
- Be specific - include names, dates, and numbers when mentioned

## Output Format
Structure your response exactly as follows:

## Call Summary

**Caller's Goal:** [Primary reason for the call in one sentence]

**Key Information Collected:**
- [Important fact 1]
- [Important fact 2]
- [Additional facts as bullet points]

**Commitments/Promises Made:**
- [Any commitments made during the call, or "None" if none were made]

**Caller's Emotional State:** [Brief description: calm, frustrated, anxious, etc.]

**Recommended Next Steps:**
- [What the agent should do first]
- [Additional action items]

**Additional Context:** [Any other relevant information the agent should know]`;
}

/**
 * Generate instructions for Sentiment Analysis insight
 */
function generateSentimentInstructions(workflow) {
  return `You are analyzing the emotional tone and sentiment of a conversation from the "${workflow.name}" workflow.

## Your Task
Provide a detailed sentiment analysis that helps a human agent understand the caller's emotional journey and how to best continue the conversation.

## Requirements
- Use **Markdown formatting** for clear presentation
- Track how sentiment changed throughout the conversation
- Identify specific trigger points (what improved or worsened their mood)
- Provide actionable advice for the human agent
- Be empathetic and practical in your recommendations

## Output Format
Structure your response exactly as follows:

## Sentiment Analysis

**Overall Sentiment:** [Positive/Neutral/Negative] (Score: X/10 where 10 is very positive)

**Sentiment Journey:**
| Phase | Sentiment | Trigger |
|-------|-----------|---------|
| Opening | [emoji + label] | [What caused this sentiment] |
| Middle | [emoji + label] | [What caused any change] |
| Before Transfer | [emoji + label] | [Final emotional state] |

Use these emojis: 😊 Positive, 😐 Neutral, 😟 Concerned, 😠 Frustrated, 😢 Upset

**Key Emotional Triggers:**
- 👍 **Positive:** [What made them feel better]
- 👎 **Negative:** [What caused frustration or concern]

**Communication Style Observed:**
[Brief description of how the caller communicates - formal/informal, verbose/concise, etc.]

**Agent Recommendations:**
- **Tone to use:** [Recommended communication approach]
- **Topics to address first:** [Priority items based on emotional state]
- **Things to avoid:** [Potential triggers to be careful about]
- **Rapport building tip:** [Specific suggestion based on the conversation]`;
}

/**
 * Generate instructions for Workflow Slots extraction insight
 */
function generateSlotsInstructions(workflow) {
  let instructions = `You are extracting structured data from a conversation in the "${workflow.name}" workflow.

## Your Task
Extract specific information (slots) that were collected during the AI assistant's conversation with the caller. This data will pre-populate a form for the human agent.

## Workflow Context
${workflow.description}

## Slots to Extract

`;

  // Add each slot with detailed instructions
  for (const slot of workflow.slots) {
    instructions += `### ${slot.slot_name}
- **Label:** ${slot.label}
- **Type:** ${slot.slot_type}
- **Description:** ${slot.description}
`;
    if (slot.hints?.length) {
      instructions += `- **Valid Values:** ${slot.hints.join(', ')}\n`;
    }
    instructions += '\n';
  }

  instructions += `## Extraction Rules

1. **Only extract explicitly stated information** - Do not infer or guess values
2. **Confidence scoring:**
   - 1.0 = Explicitly and clearly stated
   - 0.8-0.9 = Stated but might need verification
   - 0.6-0.7 = Implied or partially stated
   - Below 0.6 = Do not include (set to null)
3. **Source utterance:** Include the exact quote where the information was mentioned
4. **Null values:** If information was not provided or is unclear, set value to null

## Output Format
Return a JSON object with this exact structure:

{
  "slots": {
`;

  // Add slot structure examples
  for (const slot of workflow.slots) {
    instructions += `    "${slot.slot_name}": {
      "value": <extracted value or null>,
      "confidence": <0.0-1.0 or null if no value>,
      "source_utterance": "<exact quote from conversation or null>"
    },
`;
  }

  instructions += `  },
  "completed_stages": ["<list of stage names where ALL information was collected>"]
}

## Stage Completion Rules
A stage is "completed" only if ALL required information for that stage was successfully collected:
`;

  for (const stage of workflow.stages) {
    instructions += `- **${stage.name}:** ${stage.description}\n`;
  }

  return instructions;
}

/**
 * Generate JSON schema for slots extraction
 */
function generateSlotsSchema(workflow) {
  const slotProperties = {};
  
  for (const slot of workflow.slots) {
    let valueSchema;
    
    switch (slot.slot_type) {
      case 'email':
        valueSchema = { type: 'string', format: 'email' };
        break;
      case 'phone':
        valueSchema = { type: 'string', pattern: '^\\+?[0-9\\s\\-()]+$' };
        break;
      case 'number':
      case 'currency':
        valueSchema = { type: 'number' };
        break;
      case 'integer':
        valueSchema = { type: 'integer' };
        break;
      case 'boolean':
        valueSchema = { type: 'boolean' };
        break;
      case 'date':
        valueSchema = { type: 'string', format: 'date' };
        break;
      case 'datetime':
        valueSchema = { type: 'string', format: 'date-time' };
        break;
      case 'enum':
        valueSchema = slot.hints?.length 
          ? { type: 'string', enum: slot.hints }
          : { type: 'string' };
        break;
      default:
        valueSchema = { type: 'string' };
    }
    
    slotProperties[slot.slot_name] = {
      type: 'object',
      properties: {
        value: { ...valueSchema, nullable: true },
        confidence: { type: 'number', minimum: 0, maximum: 1, nullable: true },
        source_utterance: { type: 'string', nullable: true }
      },
      description: `${slot.label}: ${slot.description}`
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
        description: 'Names of workflow stages where all information was collected'
      }
    },
    required: ['slots']
  };
}

/**
 * Generate AI Assistant instructions from workflow
 */
function generateAssistantInstructions(workflow) {
  let instructions = `# ${workflow.name}

${workflow.description}

## Your Role
You are a friendly and professional AI assistant helping callers with their healthcare intake process. Your goal is to collect necessary information efficiently while being empathetic and helpful.

## Information to Collect

`;

  for (const stage of workflow.stages) {
    instructions += `### ${stage.name}\n${stage.description}\n\n`;
  }

  instructions += `## Conversation Guidelines

1. **Be warm and professional** - Start with a friendly greeting
2. **Explain the process** - Let the caller know what information you'll need
3. **One thing at a time** - Don't overwhelm with multiple questions
4. **Confirm important details** - Repeat back critical information like names and dates
5. **Be patient** - Allow time for responses, especially for medical details
6. **Handle sensitive topics carefully** - Health information requires empathy
7. **Transfer gracefully** - When transferring to a human agent, summarize what was discussed

## Transfer Trigger
If the caller asks to speak to a human agent at any point, acknowledge their request politely and initiate the transfer. Say something like: "Of course, I'll connect you with one of our team members right away. I'll share the information we've discussed so they can assist you better."

## Data to Collect
`;

  for (const slot of workflow.slots) {
    instructions += `- **${slot.label}**: ${slot.description}\n`;
  }

  return instructions;
}

// ============ Test Functions ============

async function testCreateAssistant() {
  console.log('\n🤖 Creating AI Assistant...');
  
  const instructions = generateAssistantInstructions(TEST_WORKFLOW);
  
  const response = await telnyxFetch('/ai/assistants', {
    method: 'POST',
    body: JSON.stringify({
      name: `[TEST] ${TEST_WORKFLOW.name}`,
      model: 'openai/gpt-4o',
      instructions: instructions,
      greeting: `Hello! Thank you for calling. I'm an AI assistant here to help start your healthcare intake process. I'll collect some basic information and then connect you with a member of our team. How can I help you today?`,
      voice_settings: {
        voice: 'nova'
      },
      transcription: {
        model: 'telnyx_enhanced',
        language: 'en'
      }
    }),
  });
  
  // Note: Assistants API returns ID directly, not under .data
  const assistantId = response.id || response.data?.id;
  createdResources.assistantId = assistantId;
  
  console.log(`   ✅ Created Assistant: ${assistantId}`);
  console.log(`   Name: [TEST] ${TEST_WORKFLOW.name}`);
  console.log(`   Model: openai/gpt-4o`);
  
  return assistantId;
}

async function testCreateInsightGroup() {
  console.log('\n📦 Creating Insight Group...');
  
  const response = await telnyxFetch('/ai/conversations/insight-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `WF: ${TEST_WORKFLOW.name}`,
      description: `Insight group for workflow: ${TEST_WORKFLOW.name}. Contains 3 insights: Summary, Sentiment Analysis, and Workflow Slots extraction.`,
      webhook: WEBHOOK_URL,
    }),
  });
  
  const groupId = response.data?.id;
  createdResources.insightGroupId = groupId;
  
  console.log(`   ✅ Created Insight Group: ${groupId}`);
  console.log(`   Name: WF: ${TEST_WORKFLOW.name}`);
  console.log(`   Webhook: ${WEBHOOK_URL}`);
  
  return groupId;
}

async function testCreateSummaryInsight() {
  console.log('\n📝 Creating Summary Insight...');
  
  const instructions = generateSummaryInstructions(TEST_WORKFLOW);
  
  const response = await telnyxFetch('/ai/conversations/insights', {
    method: 'POST',
    body: JSON.stringify({
      name: `${TEST_WORKFLOW.name} - Summary`,
      instructions: instructions,
    }),
  });
  
  const insightId = response.data?.id;
  createdResources.insightIds.summary = insightId;
  
  console.log(`   ✅ Created Summary Insight: ${insightId}`);
  console.log(`   Instructions length: ${instructions.length} chars`);
  
  return insightId;
}

async function testCreateSentimentInsight() {
  console.log('\n📝 Creating Sentiment Analysis Insight...');
  
  const instructions = generateSentimentInstructions(TEST_WORKFLOW);
  
  const response = await telnyxFetch('/ai/conversations/insights', {
    method: 'POST',
    body: JSON.stringify({
      name: `${TEST_WORKFLOW.name} - Sentiment`,
      instructions: instructions,
    }),
  });
  
  const insightId = response.data?.id;
  createdResources.insightIds.sentiment = insightId;
  
  console.log(`   ✅ Created Sentiment Insight: ${insightId}`);
  console.log(`   Instructions length: ${instructions.length} chars`);
  
  return insightId;
}

async function testCreateSlotsInsight() {
  console.log('\n📝 Creating Workflow Slots Insight...');
  
  const instructions = generateSlotsInstructions(TEST_WORKFLOW);
  const jsonSchema = generateSlotsSchema(TEST_WORKFLOW);
  
  const response = await telnyxFetch('/ai/conversations/insights', {
    method: 'POST',
    body: JSON.stringify({
      name: `${TEST_WORKFLOW.name} - Slots`,
      instructions: instructions,
      json_schema: jsonSchema,
    }),
  });
  
  const insightId = response.data?.id;
  createdResources.insightIds.slots = insightId;
  
  console.log(`   ✅ Created Slots Insight: ${insightId}`);
  console.log(`   Instructions length: ${instructions.length} chars`);
  console.log(`   JSON Schema slots: ${Object.keys(jsonSchema.properties.slots.properties).join(', ')}`);
  
  return insightId;
}

async function testAssignInsightsToGroup(groupId, insightIds) {
  console.log('\n🔗 Assigning Insights to Group...');
  
  for (const [type, insightId] of Object.entries(insightIds)) {
    console.log(`   Assigning ${type} insight (${insightId.slice(0, 8)}...)...`);
    
    await telnyxFetch(`/ai/conversations/insight-groups/${groupId}/insights/${insightId}/assign`, {
      method: 'POST',
    });
    
    console.log(`   ✅ ${type} assigned`);
  }
}

async function testUpdateAssistantWithInsights(assistantId, insightGroupId) {
  console.log('\n🔄 Updating Assistant with Insight Settings...');
  
  const response = await telnyxFetch(`/ai/assistants/${assistantId}`, {
    method: 'POST',
    body: JSON.stringify({
      insight_settings: {
        insight_group_id: insightGroupId,
      },
    }),
  });
  
  // Note: Assistants API returns data directly, not under .data
  const assistantData = response.id ? response : response.data;
  const updatedSettings = assistantData?.insight_settings;
  
  console.log(`   ✅ Assistant updated`);
  console.log(`   insight_settings.insight_group_id: ${updatedSettings?.insight_group_id}`);
  
  return assistantData;
}

async function testVerifySetup(assistantId, groupId) {
  console.log('\n🔍 Verifying Complete Setup...');
  
  // Verify Assistant (API returns data directly, not under .data)
  console.log('\n   --- Assistant ---');
  const assistantResp = await telnyxFetch(`/ai/assistants/${assistantId}`);
  const assistant = assistantResp.id ? assistantResp : assistantResp.data;
  console.log(`   ID: ${assistant.id}`);
  console.log(`   Name: ${assistant.name}`);
  console.log(`   Model: ${assistant.model}`);
  console.log(`   Insight Group ID: ${assistant.insight_settings?.insight_group_id || 'NOT SET'}`);
  
  // Verify Insight Group
  console.log('\n   --- Insight Group ---');
  const group = await telnyxFetch(`/ai/conversations/insight-groups/${groupId}`);
  console.log(`   ID: ${group.data.id}`);
  console.log(`   Name: ${group.data.name}`);
  console.log(`   Webhook: ${group.data.webhook}`);
  console.log(`   Insights count: ${group.data.insights?.length || 0}`);
  
  // Verify each insight in group
  if (group.data.insights?.length) {
    console.log('\n   --- Insights in Group ---');
    for (const insight of group.data.insights) {
      console.log(`\n   📋 ${insight.name}`);
      console.log(`      ID: ${insight.id}`);
      console.log(`      Has JSON Schema: ${insight.json_schema ? 'Yes' : 'No'}`);
      console.log(`      Instructions preview: ${insight.instructions?.slice(0, 100)}...`);
    }
  }
  
  // Validation
  const isValid = 
    assistant.insight_settings?.insight_group_id === groupId &&
    group.data.insights?.length === 3;
  
  if (isValid) {
    console.log('\n   ✅ VALIDATION PASSED - All components properly connected');
  } else {
    console.log('\n   ❌ VALIDATION FAILED - Setup incomplete');
    console.log(`      Assistant insight_group_id: ${assistant.insight_settings?.insight_group_id}`);
    console.log(`      Expected group_id: ${groupId}`);
    console.log(`      Insights count: ${group.data.insights?.length}`);
  }
  
  return { assistant, group: group.data, isValid };
}

async function testCleanup() {
  console.log('\n🧹 Cleaning up test resources...');
  
  // Delete insights first (they must be unassigned from group first, or delete group first)
  if (createdResources.insightGroupId) {
    try {
      await telnyxFetch(`/ai/conversations/insight-groups/${createdResources.insightGroupId}`, { method: 'DELETE' });
      console.log(`   ✅ Deleted Insight Group: ${createdResources.insightGroupId}`);
    } catch (err) {
      console.log(`   ⚠️ Failed to delete Insight Group: ${err.message}`);
    }
  }
  
  // Delete insights
  for (const [type, insightId] of Object.entries(createdResources.insightIds)) {
    if (insightId) {
      try {
        await telnyxFetch(`/ai/conversations/insights/${insightId}`, { method: 'DELETE' });
        console.log(`   ✅ Deleted ${type} Insight: ${insightId}`);
      } catch (err) {
        console.log(`   ⚠️ Failed to delete ${type} Insight: ${err.message}`);
      }
    }
  }
  
  // Delete assistant (unless --keep-assistant)
  if (createdResources.assistantId && !keepAssistant) {
    try {
      await telnyxFetch(`/ai/assistants/${createdResources.assistantId}`, { method: 'DELETE' });
      console.log(`   ✅ Deleted Assistant: ${createdResources.assistantId}`);
    } catch (err) {
      console.log(`   ⚠️ Failed to delete Assistant: ${err.message}`);
    }
  } else if (keepAssistant) {
    console.log(`   ⏭️ Keeping Assistant (--keep-assistant): ${createdResources.assistantId}`);
  }
}

// ============ Main ============

async function main() {
  console.log('═'.repeat(70));
  console.log('🧪 AI to Agent Workflow Handoff - Full Integration Test');
  console.log('═'.repeat(70));
  console.log(`\nWebhook URL: ${WEBHOOK_URL}`);
  console.log(`Cleanup after test: ${shouldCleanup}`);
  console.log(`Keep assistant: ${keepAssistant}`);
  console.log(`\nTest Workflow: ${TEST_WORKFLOW.name}`);
  console.log(`Slots: ${TEST_WORKFLOW.slots.map(s => s.slot_name).join(', ')}`);
  
  try {
    // Step 1: Create AI Assistant
    const assistantId = await testCreateAssistant();
    
    // Step 2: Create Insight Group
    const groupId = await testCreateInsightGroup();
    
    // Step 3: Create all 3 Insights
    const summaryId = await testCreateSummaryInsight();
    const sentimentId = await testCreateSentimentInsight();
    const slotsId = await testCreateSlotsInsight();
    
    // Step 4: Assign all insights to group
    await testAssignInsightsToGroup(groupId, {
      summary: summaryId,
      sentiment: sentimentId,
      slots: slotsId
    });
    
    // Step 5: Update Assistant with insight settings
    await testUpdateAssistantWithInsights(assistantId, groupId);
    
    // Step 6: Verify complete setup
    const { isValid } = await testVerifySetup(assistantId, groupId);
    
    console.log('\n' + '═'.repeat(70));
    if (isValid) {
      console.log('✅ ALL TESTS PASSED - Full Integration Complete!');
    } else {
      console.log('⚠️ TESTS COMPLETED WITH WARNINGS');
    }
    console.log('═'.repeat(70));
    
    console.log('\n📋 Created Resources Summary:');
    console.log(`   Assistant ID: ${createdResources.assistantId}`);
    console.log(`   Insight Group ID: ${createdResources.insightGroupId}`);
    console.log(`   Summary Insight ID: ${createdResources.insightIds.summary}`);
    console.log(`   Sentiment Insight ID: ${createdResources.insightIds.sentiment}`);
    console.log(`   Slots Insight ID: ${createdResources.insightIds.slots}`);
    
    // Cleanup if requested
    if (shouldCleanup) {
      await testCleanup();
    } else {
      console.log('\n💡 Resources kept for manual testing.');
      console.log('   Run with --cleanup to delete test resources');
      console.log('   Run with --keep-assistant to preserve assistant during cleanup');
    }
    
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    console.error(err.stack);
    
    if (shouldCleanup) {
      console.log('\n🧹 Attempting cleanup after failure...');
      await testCleanup();
    }
    
    process.exit(1);
  }
}

main();
