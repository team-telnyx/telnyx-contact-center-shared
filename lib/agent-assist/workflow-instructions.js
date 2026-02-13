/**
 * Generate AI assistant instructions from workflow stages and items.
 * Used when creating or updating a workflow-linked AI agent.
 *
 * @param {object} workflow - Workflow with name, description
 * @param {array} stages - Workflow stages with items
 * @returns {string} Generated instructions for the AI assistant
 */
export function generateWorkflowInstructions(workflow, stages = []) {
  let instructions = `# ${workflow?.name || "AI Assistant"}\n\n`;
  instructions += workflow?.description || "You are a helpful AI assistant.";
  instructions += "\n\n";

  if (stages && stages.length > 0) {
    instructions += "## Conversation Flow:\n\n";

    stages.forEach((stage, stageIdx) => {
      instructions += `### Stage ${stageIdx + 1}: ${stage.name}\n`;
      if (stage.description) {
        instructions += `${stage.description}\n`;
      }
      instructions += "\n";

      if (stage.items && stage.items.length > 0) {
        stage.items.forEach((item) => {
          const itemType = item.item_type || item.type;
          const label = item.label || item.name;
          const description = item.description || "";

          if (itemType === "question") {
            instructions += `- **Ask**: ${label}`;
            if (description) instructions += ` (${description})`;
            instructions += "\n";
          } else if (itemType === "action") {
            instructions += `- **Action**: ${label}`;
            if (description) instructions += ` - ${description}`;
            instructions += "\n";
          } else if (itemType === "topic") {
            instructions += `- **Cover topic**: ${label}`;
            if (description) instructions += ` - ${description}`;
            instructions += "\n";
          } else if (itemType === "slot") {
            instructions += `- **Collect**: ${label}`;
            if (item.slot_type) instructions += ` (${item.slot_type})`;
            if (description) instructions += ` - ${description}`;
            instructions += "\n";
          } else {
            instructions += `- ${label}`;
            if (description) instructions += `: ${description}`;
            instructions += "\n";
          }
        });
      }
      instructions += "\n";
    });
  }

  instructions += "\n## Guidelines:\n";
  instructions += "- Be professional, friendly, and helpful\n";
  instructions += "- Follow the conversation flow above\n";
  instructions += "- **IMPORTANT: Ask for ONE piece of information at a time.** Never ask for multiple data points in a single question.\n";
  instructions += "  - ✅ Good: \"Could you provide me your first and last name?\"\n";
  instructions += "  - ✅ Good: \"What is your date of birth?\"\n";
  instructions += "  - ❌ Bad: \"Could you provide your name, date of birth, email, and phone number?\"\n";
  instructions += "- Wait for the caller to respond before asking for the next piece of information\n";
  instructions += "- Confirm important information before proceeding\n";
  instructions += "- If the caller wants to speak to a human, offer to transfer them\n";

  instructions += "\n## Call Context\n\n";
  instructions += "The call is taking place via the {{telnyx_conversation_channel}} channel on {{telnyx_current_time}}. ";
  instructions += "The agent is at {{telnyx_agent_target}}, and the client is at {{telnyx_end_user_target}}.\n";

  instructions += "\n## Tools\n\n";
  instructions += "Use the **transfer** tool when:\n";
  instructions += "- The caller explicitly asks to speak with a human agent\n";
  instructions += "- The caller's issue requires human assistance beyond your capabilities\n";
  instructions += "- You have collected all required information and need to transfer to the contact center\n\n";
  instructions += "Use the **hangup** tool when:\n";
  instructions += "- The caller indicates they want to end the call\n";
  instructions += "- The caller's questions have been fully answered and they confirm they're done\n";
  instructions += "- The caller says goodbye or thanks you for your help\n\n";
  instructions += "For transfers, let them know they will be connected to a human agent. ";
  instructions += "For hangups, thank them for calling and confirm they don't need anything else.\n";

  return instructions;
}
