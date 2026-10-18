
export function buildPromptsForScenarioType(scenarioType, workflow) {
  const workflowName = workflow?.name || "this workflow";
  const workflowContext = `This workflow is: "${workflowName}". Adapt responses to fit this context (e.g. survey, intake, support, etc.).`;

  const baseSystemPrompt = `You generate realistic test scenarios for AI voice/chat assistants.
Given a scenario type and workflow context, produce a JSON object with a "responses" array.

CRITICAL: The "text" field is ALWAYS what the CUSTOMER (caller/user) says in response to the AI. The AI agent leads the conversation (greetings, questions, surveys). The customer ONLY responds. NEVER generate:
- Agent introductions ("Hi, I'm [name] from [team], I'd like to ask you...")
- Survey scripts or questions (the AI does that)
- What the AI would say

## Response Format Rules
1. **keywords** (required except first): Use DISCRIMINATIVE words that uniquely identify which question the AI is asking.
   Prefer specific terms (e.g. "recommend", "nps" for NPS; "improve", "suggestions" for feedback) over generic ones ("yes", "ok").
   Include 3-6 keywords per step - avoid overlap with other steps so each response matches the correct question.

2. **text** (required): The customer's response. Be varied - use different names, numbers, dates each time.

3. **First response**: Include "waitForGreeting": true. Customer's opening line after AI greets.

4. Output ONLY valid JSON with a "responses" array.`;

  const baseUserPrefix = `Workflow context: ${workflowContext}
`;

  const instructions = {
    workflow_specific: {
      system: baseSystemPrompt + `
5. **Order**: One response per workflow item, in order. Customer is cooperative. Each "text" is the customer's answer to that item.
6. **Variety**: Randomize names, phone numbers, dates, facilities - never reuse same values.
7. **Customer only**: "text" = customer response. Never agent dialogue or questions.`,
      buildUserPrompt: (workflow) => {
        const stages = workflow?.stages ?? [];
        const items = stages.flatMap((s) => (s.items ?? []).map((i) => ({ ...i, stage_name: s.name })));
        const collectibleItems = items.filter((item) => {
          const type = item.item_type || item.type || "action";
          return type !== "action";
        });
        if (collectibleItems.length === 0) return null;
        const itemsDesc = collectibleItems
          .map((item, idx) => {
            const type = item.item_type || item.type || "action";
            let line = `${idx + 1}. [${type}] ${item.label || item.name || "Item"}`;
            if (item.slot_name) line += ` (slot: ${item.slot_name}, type: ${item.slot_type || "text"})`;
            if (item.prompt_hint) line += ` - hint: "${item.prompt_hint}"`;
            return line;
          })
          .join("\n");
        return `${baseUserPrefix}Scenario: Complete Workflow - customer cooperatively answers each item in order.

Items (generate one response per item, in order):
${itemsDesc}

Output JSON:
{ "responses": [ { "waitForGreeting": true, "keywords": [...], "text": "..." }, ... ] }`;
      },
    },
    early_transfer: {
      system: baseSystemPrompt + `
5. **Scenario**: Customer wants a human agent from the very start. Short scenario: 2-4 responses.`,
      buildUserPrompt: () => `${baseUserPrefix}Scenario: Early Transfer Requested

Generate 2-4 responses (CUSTOMER says these):
- Response 1 (waitForGreeting): Customer immediately asks for human. Examples: "I need to speak with a real person", "Can I talk to an agent?"
- Response 2: AI may offer to help - customer insists. Examples: "No, I really want a person", "Just transfer me please"
- Response 3-4: Customer confirms when AI offers transfer. "Yes please transfer me". Keywords: "transfer", "connect", "yes"

Output JSON.`,
    },
    mid_workflow_transfer: {
      system: baseSystemPrompt + `
5. **Scenario**: Customer starts cooperatively, then requests transfer midway. 4-6 responses.`,
      buildUserPrompt: (workflow) => {
        const stages = workflow?.stages ?? [];
        const sampleItems = stages.flatMap((s) => s.items ?? []).slice(0, 3);
        const sampleDesc = sampleItems.length
          ? `Workflow may ask for: ${sampleItems.map((i) => i.label || i.name).join(", ")}.`
          : "Workflow gathers some information.";
        return `${baseUserPrefix}Scenario: Mid-Workflow Transfer

Generate 4-6 responses where (CUSTOMER says these, in response to AI):
- Response 1 (waitForGreeting): Customer states their need. Examples: "Hello, I need help with my account", "Hi, I'd like to take the survey"
- Response 2: Customer answers AI's first question. Examples: "My name is Sarah Johnson", "Sure, I have a few minutes"
- Response 3: Customer says it's getting complicated. Examples: "Actually, can I speak to someone?", "This is more complex than I thought, I'd like an agent"
- Response 4+: Customer confirms transfer when AI offers. "Yes please transfer me"

Never write agent dialogue. Customer only responds to the AI. Output JSON.`;
      },
    },
    out_of_order: {
      system: baseSystemPrompt + `
5. **Scenario**: Customer gives information in unexpected order, often multiple items at once. 4-7 responses.`,
      buildUserPrompt: (workflow) => {
        const stages = workflow?.stages ?? [];
        const sampleItems = stages.flatMap((s) => s.items ?? []).slice(0, 5);
        const sampleDesc = sampleItems.length
          ? `Relevant info types: ${sampleItems.map((i) => i.label || i.name).join(", ")}.`
          : "Names, dates, numbers, locations, etc.";
        return `${baseUserPrefix}Scenario: Out of Order Information

Generate 4-7 responses where (CUSTOMER says these):
- Response 1 (waitForGreeting): Customer dumps 2-4 pieces of info in one go. Example: "Hi, my name is [name], I'm calling from [place] - the [subject] is [name2], born [date]" (customer providing their info, not asking questions)
- Responses 2+: When AI asks to confirm or fill gaps, customer says "Yes that's right" or provides the missing piece. May add more info out of order.
- Last: "No, that's everything" or similar.

${sampleDesc} Jumble these in the opening. Variety: Different names, dates, numbers. Output JSON.`;
      },
    },
    frustrated_customer: {
      system: baseSystemPrompt + `
5. **Scenario**: Customer is upset, curt, may request transfer. 4-7 responses.`,
      buildUserPrompt: () => `${baseUserPrefix}Scenario: Frustrated Customer

Generate 4-7 responses (CUSTOMER says these):
- Response 1 (waitForGreeting): Frustrated opening. Examples: "I've been trying to get help all day!", "Nobody can assist me!", "This is ridiculous"
- Response 2: AI apologizes - customer stays upset. Examples: "I just need someone who knows what they're doing", "Fine, I need to [brief request]"
- Responses 3+: Short, curt answers. May snap: "Yes.", "Whatever.", "Just do it."
- May request transfer midway: "Can I just speak to a person?"
- Last: "No. Goodbye." or "Fine. That's it."

Variety: Different frustration levels and phrasings. Output JSON.`,
    },
  };

  return instructions[scenarioType] || instructions.workflow_specific;
}
