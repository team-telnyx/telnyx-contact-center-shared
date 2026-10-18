import { buildPromptsForScenarioType } from '../ai-operations/prompts/scenario.mjs';
import { prepareAiOperation } from '@/lib/ai-operations/runtime.mjs';
import { agentAssistRuntimePayload, llmLogger } from "./logging.mjs";
/**
 * Generate test scenario via LLM
 *
 * Creates realistic test data for workflow testing. Each scenario type has
 * predefined instructions so the LLM generates appropriate responses.
 */

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/** Scenario type configurations with LLM instructions */
export const SCENARIO_TYPES = {
  workflow_specific: {
    id: "workflow_specific",
    name: "Complete Workflow",
    description: "Customer cooperatively completes all workflow steps in order",
  },
  early_transfer: {
    id: "early_transfer",
    name: "Early Transfer Requested",
    description: "Customer immediately requests to speak with a human",
  },
  mid_workflow_transfer: {
    id: "mid_workflow_transfer",
    name: "Mid-Workflow Transfer",
    description: "Customer starts the process but requests transfer midway",
  },
  out_of_order: {
    id: "out_of_order",
    name: "Out of Order Information",
    description: "Customer provides information in unexpected order",
  },
  frustrated_customer: {
    id: "frustrated_customer",
    name: "Frustrated Customer",
    description: "Customer is upset and expresses frustration",
  },
};

/**
 * Build system and user prompts for each scenario type
 */


/**
 * Generate a test scenario from workflow and scenario type
 * @param {Object} options
 * @param {Object} options.workflow - Workflow with stages and items
 * @param {string} options.scenarioType - One of workflow_specific, early_transfer, mid_workflow_transfer, out_of_order, frustrated_customer
 * @param {string} [options.model] - Optional explicit model; otherwise AI Copilot "Workflow test scenarios", then the platform default
 * @param {boolean} [options.reasoningEnabled] - Explicit workflow reasoning setting
 * @returns {Promise<Object|null>} Scenario { id, name, description, responses } or null
 */
export async function generateTestScenario({ workflow, scenarioType = "workflow_specific", model, reasoningEnabled = false }) {
  const config = SCENARIO_TYPES[scenarioType] || SCENARIO_TYPES.workflow_specific;
  const promptConfig = buildPromptsForScenarioType(scenarioType, workflow);

  const userPrompt = promptConfig.buildUserPrompt(workflow);
  if (!userPrompt) return null;

  try {
    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify(await prepareAiOperation('test-scenario', {
        messages: [
          { role: "system", content: promptConfig.system },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.9,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        enable_thinking: reasoningEnabled === true,
      }, {preferredModel: model})),
    });

    if (!response.ok) {
      const providerErrorSummary = await response.text();
      llmLogger.error("generatetestscenario", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content in AI response");

    const parsed = JSON.parse(content);
    const responses = parsed?.responses;
    if (!Array.isArray(responses) || responses.length === 0) {
      throw new Error("Invalid scenario format: missing or empty responses");
    }

    // Build collectible items for workflow_specific (same as prompt)
    const collectibleItems =
      scenarioType === "workflow_specific" && workflow?.stages
        ? workflow.stages.flatMap((s) => s.items ?? []).filter(
            (item) => (item.item_type || item.type || "action") !== "action"
          )
        : [];

    const normalized = responses.map((r, i) => {
      const step = { ...r };
      if (i === 0 && !step.waitForGreeting) step.waitForGreeting = true;
      if (!Array.isArray(step.keywords)) step.keywords = ["yes", "ok"];
      // Augment keywords from workflow item's prompt_hint and label so AI phrasing always matches
      const item = collectibleItems[i];
      if (item) {
        const extraKeywords = [];
        if (item.prompt_hint && typeof item.prompt_hint === "string") {
          item.prompt_hint
            .split(/[\s,;:|]+/)
            .filter(Boolean)
            .forEach((w) => {
              const lower = w.toLowerCase();
              if (lower.length > 2 && !step.keywords.some((k) => String(k).toLowerCase() === lower)) {
                extraKeywords.push(lower);
              }
            });
        }
        const label = item.label || item.name || "";
        if (label) {
          label
            .split(/[\s,;:|]+/)
            .filter(Boolean)
            .forEach((w) => {
              const lower = w.toLowerCase();
              if (lower.length > 2 && !step.keywords.some((k) => String(k).toLowerCase() === lower) && !extraKeywords.includes(lower)) {
                extraKeywords.push(lower);
              }
            });
        }
        if (extraKeywords.length) {
          step.keywords = [...new Set([...step.keywords, ...extraKeywords])];
        }
      }
      if (!step.text || typeof step.text !== "string") step.text = "Yes";
      return step;
    });

    return {
      id: config.id,
      name: config.name,
      description: config.description,
      responses: normalized,
    };
  } catch (err) {
    llmLogger.error("generatetestscenario", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    throw err;
  }
}
