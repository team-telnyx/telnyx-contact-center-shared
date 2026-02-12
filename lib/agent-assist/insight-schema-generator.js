/**
 * Insight Schema Generator
 * 
 * Generates JSON schemas and instructions for Telnyx Insights
 * based on workflow configuration.
 */

/**
 * Get JSON schema type for a slot type
 * @param {string} slotType - Slot type (text, number, date, email, phone, boolean, enum)
 * @returns {Object} JSON schema definition for the value
 */
export function getValueSchemaForType(slotType) {
  switch (slotType?.toLowerCase()) {
    case "number":
    case "integer":
      return { type: "number" };
    
    case "boolean":
      return { type: "boolean" };
    
    case "date":
      return { 
        type: "string", 
        format: "date",
        description: "Date in ISO 8601 format (YYYY-MM-DD)"
      };
    
    case "datetime":
      return { 
        type: "string", 
        format: "date-time",
        description: "Date and time in ISO 8601 format"
      };
    
    case "email":
      return { 
        type: "string", 
        format: "email",
        description: "Valid email address"
      };
    
    case "phone":
      return { 
        type: "string",
        description: "Phone number (may include country code)"
      };
    
    case "url":
      return { 
        type: "string", 
        format: "uri",
        description: "Valid URL"
      };
    
    case "enum":
      // Enum options are handled separately in generateSlotsSchema
      return { type: "string" };
    
    case "text":
    case "string":
    default:
      return { type: "string" };
  }
}

/**
 * Generate combined JSON schema for all workflow slots
 * @param {Array} workflowSlots - Array of slot configurations
 * @returns {Object} JSON schema for Telnyx Insight
 */
export function generateSlotsSchema(workflowSlots) {
  const slotProperties = {};

  for (const slot of workflowSlots) {
    const valueSchema = getValueSchemaForType(slot.slot_type);
    
    // Handle enum type with options
    if (slot.slot_type === "enum" && Array.isArray(slot.slot_options)) {
      valueSchema.enum = slot.slot_options;
    }

    slotProperties[slot.slot_name] = {
      type: "object",
      properties: {
        value: {
          ...valueSchema,
          description: `Value for: ${slot.label}`,
          nullable: true,
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Confidence score 0-1, null if value not found",
          nullable: true,
        },
        source_utterance: {
          type: "string",
          description: "Exact quote from conversation where value was mentioned",
          nullable: true,
        },
      },
      description: slot.description || slot.label,
    };
  }

  return {
    type: "object",
    properties: {
      slots: {
        type: "object",
        properties: slotProperties,
        description: "Extracted slot values from the conversation",
      },
      completed_stages: {
        type: "array",
        items: { type: "string" },
        description: "List of stage names that were fully completed during the conversation",
      },
    },
    required: ["slots"],
  };
}

/**
 * Generate extraction instructions for slots insight
 * @param {Object} workflow - Workflow object with name and description
 * @param {Array} stages - Array of workflow stages with items
 * @returns {string} Instructions for the slots extraction insight
 */
export function generateSlotsInstructions(workflow, stages) {
  let instructions = `Analyze the conversation and extract information for the "${workflow.name}" workflow.\n\n`;
  
  if (workflow.description) {
    instructions += `**Context:** ${workflow.description}\n\n`;
  }

  instructions += `## Slots to Extract\n\n`;

  for (const stage of stages) {
    const items = stage.items || [];
    const slotItems = items.filter((item) => item.type === "slot" && item.slot_name);
    
    if (slotItems.length === 0) continue;

    instructions += `### ${stage.name}\n`;
    
    for (const item of slotItems) {
      const typeHint = item.slot_type ? ` (${item.slot_type})` : "";
      instructions += `- **${item.slot_name}**${typeHint}: ${item.label}`;
      
      if (item.description) {
        instructions += `\n  - Description: ${item.description}`;
      }
      
      if (item.hints?.length > 0) {
        instructions += `\n  - Detection hints: ${item.hints.join(", ")}`;
      }
      
      if (item.slot_type === "enum" && Array.isArray(item.slot_options)) {
        instructions += `\n  - Valid options: ${item.slot_options.join(", ")}`;
      }
      
      if (item.slot_validation) {
        instructions += `\n  - Validation: ${item.slot_validation}`;
      }
      
      instructions += `\n`;
    }
    
    instructions += `\n`;
  }

  instructions += `## Extraction Rules\n\n`;
  instructions += `1. For each slot, extract the value if clearly stated in the conversation.\n`;
  instructions += `2. Set value to null if information was not provided or is unclear.\n`;
  instructions += `3. Confidence scoring:\n`;
  instructions += `   - **1.0** = Explicitly stated by the caller\n`;
  instructions += `   - **0.8-0.9** = Clearly inferred from context\n`;
  instructions += `   - **0.6-0.7** = Somewhat uncertain, needs verification\n`;
  instructions += `   - **< 0.6** = Don't include (set value to null instead)\n`;
  instructions += `4. Include the exact source_utterance where the value was mentioned.\n`;
  instructions += `5. For completed_stages, list only stages where ALL slot items were addressed.\n`;
  instructions += `6. Normalize values appropriately:\n`;
  instructions += `   - Names: proper case (e.g., "John Smith")\n`;
  instructions += `   - Dates: ISO format (YYYY-MM-DD)\n`;
  instructions += `   - Phone numbers: include country code if mentioned\n`;
  instructions += `   - Emails: lowercase\n`;

  return instructions;
}

/**
 * Generate instructions for call summary insight
 * @param {Object} workflow - Workflow object with name and description
 * @returns {string} Instructions for the summary insight
 */
export function generateSummaryInstructions(workflow) {
  return `Provide a concise summary of this ${workflow.name} conversation for a contact center agent who will continue the call.

## Context
${workflow.description || "This is a customer service conversation."}

## Requirements
- Use **Markdown formatting** for better readability
- Focus on actionable information the agent needs to know
- Highlight any commitments made or issues raised
- Note the customer's primary concern and current emotional state
- Keep it under 200 words
- Be objective and factual

## Output Format

\`\`\`markdown
## Call Summary

**Customer Goal:** [Main reason for calling - be specific]

**Key Points:**
- [Important point 1 - what was discussed/decided]
- [Important point 2]
- [Important point 3 if relevant]

**Information Collected:**
- [Data point 1 if any personal info was shared]
- [Data point 2]

**Action Items:**
- [What needs to happen next]
- [Any follow-up required]

**Transfer Reason:** [Why the customer is being transferred to a human agent]

**Notes:** [Any other relevant context for the agent - tone, urgency, special circumstances]
\`\`\`

## Guidelines
- Focus on what's relevant for the agent to continue the conversation
- Don't include internal system details
- Highlight if the customer expressed urgency or frustration
- Note any promises or commitments the AI made
`;
}

/**
 * Generate instructions for sentiment analysis insight
 * @param {Object} workflow - Workflow object with name and description
 * @returns {string} Instructions for the sentiment insight
 */
export function generateSentimentInstructions(workflow) {
  return `Analyze the customer's sentiment throughout this ${workflow.name} conversation.

## Context
${workflow.description || "This is a customer service conversation."}

## Requirements
- Use **Markdown formatting** for the output
- Track sentiment changes during the conversation
- Identify specific trigger points (what made them happy or frustrated)
- Provide actionable advice for the agent handling the transfer

## Output Format

\`\`\`markdown
## Sentiment Analysis

**Overall Sentiment:** [Positive/Neutral/Negative/Mixed] (X/10)

**Sentiment Timeline:**
1. 🟢/🟡/🔴 **Start:** [Initial mood when conversation began]
2. 🟢/🟡/🔴 **Middle:** [How sentiment changed and why]
3. 🟢/🟡/🔴 **End:** [Final state before transfer to agent]

**Trigger Points:**
- 👍 **Positive:** [What made them satisfied/happy - be specific]
- 👎 **Negative:** [What frustrated them - be specific]

**Customer Personality:**
- [Brief characterization: e.g., "Patient and detail-oriented" or "In a hurry, wants quick resolution"]

**Agent Tips:**
- [Specific advice on how to approach this customer]
- [Topics to emphasize or handle carefully]
- [Things to avoid mentioning]
\`\`\`

## Scoring Guide
- **9-10:** Very positive, satisfied, enthusiastic
- **7-8:** Positive, cooperative, pleasant
- **5-6:** Neutral, businesslike
- **3-4:** Frustrated, impatient, but manageable
- **1-2:** Very upset, angry, escalation risk

## Guidelines
- Be specific about what caused sentiment changes
- Focus on actionable insights for the agent
- Consider cultural context when interpreting tone
- Note any red flags that might indicate escalation risk
`;
}

/**
 * Generate all insight configurations for a workflow
 * @param {Object} workflow - Complete workflow object with stages
 * @returns {Object} Object containing all generated configurations
 */
export function generateAllInsightConfigs(workflow) {
  const stages = workflow.stages || [];
  
  // Collect all slots
  const allSlots = [];
  for (const stage of stages) {
    const items = stage.items || [];
    for (const item of items) {
      if (item.type === "slot" && item.slot_name) {
        allSlots.push({
          slot_name: item.slot_name,
          slot_type: item.slot_type || "text",
          label: item.label,
          description: item.description,
          hints: item.hints || [],
          slot_options: item.slot_options,
          slot_validation: item.slot_validation,
        });
      }
    }
  }

  return {
    slots: {
      schema: generateSlotsSchema(allSlots),
      instructions: generateSlotsInstructions(workflow, stages),
    },
    summary: {
      instructions: generateSummaryInstructions(workflow),
    },
    sentiment: {
      instructions: generateSentimentInstructions(workflow),
    },
  };
}
