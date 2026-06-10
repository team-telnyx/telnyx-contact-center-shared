import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { getPostgresPool } from "./postgres.mjs";

const seedLogger = createDiagnosticLogger("platform.app");

/**
 * Seed Quality Management evaluation forms.
 *
 * These are supervisor QA scorecards stored in the quality_forms table,
 * fully separate from the agent scripting form_* tables.
 *
 * Criterion schema item shape:
 * {
 *   id, label, description, type: "score" | "boolean",
 *   maxScore, weight, criticalFail,
 *   aiRubric: { excellent, poor, evidenceRequired }
 * }
 */

function criterion({ id, label, description, type = "score", maxScore = 5, weight = 1, criticalFail = false, excellent, poor }) {
  return {
    id,
    label,
    description,
    type,
    maxScore: type === "boolean" ? 1 : maxScore,
    weight,
    criticalFail,
    aiRubric: {
      excellent,
      poor,
      evidenceRequired: true,
    },
  };
}

export const QUALITY_FORM_TEMPLATES = [
  {
    name: "Customer Service Quality Scorecard",
    slug: "customer-service-quality-scorecard",
    description:
      "General-purpose scorecard for inbound customer service calls covering greeting, needs discovery, resolution, communication, and closing.",
    category: "customer-service",
    sections: [
      {
        id: "opening",
        title: "Opening",
        criteria: [
          criterion({
            id: "greeting",
            label: "Professional greeting",
            description: "Agent greets the customer, introduces themselves, and sets a helpful tone.",
            maxScore: 5,
            excellent: "Agent greets the customer warmly, states their name, and offers help within the first moments of the call.",
            poor: "No greeting, no introduction, or an abrupt/rude opening.",
          }),
          criterion({
            id: "identification",
            label: "Customer identification",
            description: "Agent confirms who they are speaking with before discussing account details.",
            maxScore: 5,
            excellent: "Agent verifies the caller's identity politely and completely before sharing any account information.",
            poor: "Agent discusses account specifics without any identity confirmation.",
          }),
        ],
      },
      {
        id: "discovery",
        title: "Understanding the need",
        criteria: [
          criterion({
            id: "active-listening",
            label: "Active listening",
            description: "Agent lets the customer explain, acknowledges what was said, and avoids interrupting.",
            maxScore: 5,
            weight: 2,
            excellent: "Agent acknowledges and paraphrases the customer's issue, asks clarifying questions, never talks over the customer.",
            poor: "Agent interrupts, ignores stated details, or asks for information the customer already gave.",
          }),
          criterion({
            id: "issue-summary",
            label: "Issue summarised back",
            description: "Agent restates the problem to confirm shared understanding.",
            maxScore: 5,
            excellent: "Agent clearly summarises the issue and the customer confirms the summary is correct.",
            poor: "Agent never confirms what the actual problem is and works on assumptions.",
          }),
        ],
      },
      {
        id: "resolution",
        title: "Resolution",
        criteria: [
          criterion({
            id: "correct-resolution",
            label: "Correct and complete resolution",
            description: "The solution offered actually addresses the customer's issue.",
            maxScore: 5,
            weight: 3,
            excellent: "Agent resolves the issue fully or sets out a concrete, correct action plan with timelines.",
            poor: "Wrong information given, issue left unresolved without a follow-up plan.",
          }),
          criterion({
            id: "ownership",
            label: "Ownership",
            description: "Agent takes responsibility instead of bouncing the customer around.",
            maxScore: 5,
            excellent: "Agent owns the problem end-to-end and avoids unnecessary transfers.",
            poor: "Agent deflects, blames other teams, or transfers without explanation.",
          }),
        ],
      },
      {
        id: "communication",
        title: "Communication",
        criteria: [
          criterion({
            id: "clarity",
            label: "Clarity and pace",
            description: "Explanations are clear, jargon-free, and easy to follow.",
            maxScore: 5,
            excellent: "Agent explains next steps in plain language and checks the customer understood.",
            poor: "Confusing, jargon-heavy, or contradictory explanations.",
          }),
          criterion({
            id: "empathy",
            label: "Empathy and tone",
            description: "Agent acknowledges customer frustration and stays professional.",
            maxScore: 5,
            excellent: "Agent acknowledges the customer's feelings and maintains a calm, friendly tone throughout.",
            poor: "Dismissive, robotic, or irritated tone; frustration ignored.",
          }),
        ],
      },
      {
        id: "closing",
        title: "Closing",
        criteria: [
          criterion({
            id: "recap-next-steps",
            label: "Recap and next steps",
            description: "Agent recaps the outcome and states what happens next.",
            maxScore: 5,
            excellent: "Agent summarises what was done, what happens next, and any timelines.",
            poor: "Call ends abruptly with no summary or next steps.",
          }),
          criterion({
            id: "further-help",
            label: "Offer of further help",
            description: "Agent asks whether anything else is needed and closes politely.",
            maxScore: 5,
            excellent: "Agent asks if there is anything else, thanks the customer, and closes warmly.",
            poor: "No closing question, abrupt hang-up.",
          }),
        ],
      },
    ],
  },
  {
    name: "Compliance QA Checklist",
    slug: "compliance-qa-checklist",
    description:
      "Pass/fail compliance checklist: identity verification, required disclosures, restricted phrases, data handling, and escalation.",
    category: "compliance",
    sections: [
      {
        id: "verification",
        title: "Identity & verification",
        criteria: [
          criterion({
            id: "identity-verified",
            label: "Identity verified before account discussion",
            description: "Agent completed the required verification steps before disclosing account data.",
            type: "boolean",
            criticalFail: true,
            excellent: "Full verification completed before any account-specific information was shared.",
            poor: "Account details disclosed without verification.",
          }),
        ],
      },
      {
        id: "disclosures",
        title: "Required disclosures",
        criteria: [
          criterion({
            id: "recording-disclosure",
            label: "Recording disclosure given",
            description: "Customer was informed the call may be recorded where required.",
            type: "boolean",
            excellent: "Clear recording/monitoring disclosure at the start of the call.",
            poor: "No disclosure despite being required.",
          }),
          criterion({
            id: "consent-captured",
            label: "Consent captured where required",
            description: "Explicit consent obtained for actions requiring it (payments, marketing, data sharing).",
            type: "boolean",
            criticalFail: true,
            excellent: "Explicit, unambiguous consent captured before the regulated action.",
            poor: "Regulated action performed without consent.",
          }),
        ],
      },
      {
        id: "conduct",
        title: "Conduct",
        criteria: [
          criterion({
            id: "no-restricted-phrases",
            label: "No restricted or misleading statements",
            description: "Agent avoided prohibited claims, guarantees, or misleading wording.",
            type: "boolean",
            criticalFail: true,
            excellent: "All statements accurate and within policy.",
            poor: "Guarantees, threats, or misleading claims made.",
          }),
          criterion({
            id: "data-handling",
            label: "Safe data handling",
            description: "No unnecessary reading back of full card numbers, passwords, or other sensitive data.",
            type: "boolean",
            excellent: "Sensitive data handled per policy, masked where appropriate.",
            poor: "Sensitive data read aloud or requested unnecessarily.",
          }),
          criterion({
            id: "escalation",
            label: "Escalation followed policy",
            description: "Complaints or regulated requests were escalated per procedure.",
            type: "boolean",
            excellent: "Escalation triggers recognised and routed correctly.",
            poor: "Complaint or regulated request ignored or mishandled.",
          }),
        ],
      },
    ],
  },
  {
    name: "Sales Conversation Scorecard",
    slug: "sales-conversation-scorecard",
    description:
      "Scorecard for sales and upsell conversations: discovery, value proposition, objection handling, accuracy, and closing.",
    category: "sales",
    sections: [
      {
        id: "discovery",
        title: "Discovery",
        criteria: [
          criterion({
            id: "needs-discovery",
            label: "Needs discovery",
            description: "Agent asks open questions to understand the customer's situation and needs.",
            maxScore: 5,
            weight: 2,
            excellent: "Agent uncovers needs, context, and constraints with open-ended questions before pitching.",
            poor: "Agent pitches immediately without understanding the customer.",
          }),
        ],
      },
      {
        id: "pitch",
        title: "Value proposition",
        criteria: [
          criterion({
            id: "tailored-value",
            label: "Tailored value proposition",
            description: "Offer is linked to the needs the customer expressed.",
            maxScore: 5,
            weight: 2,
            excellent: "Benefits framed around the customer's stated needs, not a generic script.",
            poor: "Generic feature dump with no connection to the customer's situation.",
          }),
          criterion({
            id: "product-accuracy",
            label: "Product and pricing accuracy",
            description: "Pricing, terms, and product details stated correctly.",
            maxScore: 5,
            criticalFail: true,
            excellent: "All pricing and terms accurate and complete, including conditions.",
            poor: "Incorrect pricing or hidden conditions misrepresented.",
          }),
        ],
      },
      {
        id: "objections",
        title: "Objection handling",
        criteria: [
          criterion({
            id: "objection-handling",
            label: "Objection handling",
            description: "Agent acknowledges objections and addresses them honestly.",
            maxScore: 5,
            excellent: "Objections acknowledged, explored, and answered honestly without pressure tactics.",
            poor: "Objections ignored, talked over, or met with pressure.",
          }),
        ],
      },
      {
        id: "closing",
        title: "Closing",
        criteria: [
          criterion({
            id: "clear-next-step",
            label: "Clear next step or close",
            description: "Conversation ends with a concrete commitment or follow-up.",
            maxScore: 5,
            excellent: "Agent secures a clear decision or schedules a concrete next step.",
            poor: "Conversation fizzles out with no attempt at a close or next step.",
          }),
        ],
      },
    ],
  },
  {
    name: "Technical Support QA",
    slug: "technical-support-qa",
    description:
      "Scorecard for technical support calls: troubleshooting logic, clear instructions, verification of resolution, and escalation quality.",
    category: "technical-support",
    sections: [
      {
        id: "diagnosis",
        title: "Diagnosis",
        criteria: [
          criterion({
            id: "structured-troubleshooting",
            label: "Structured troubleshooting",
            description: "Agent follows a logical diagnostic path instead of guessing.",
            maxScore: 5,
            weight: 2,
            excellent: "Agent isolates the problem step by step, ruling out causes methodically.",
            poor: "Random guesses, repeated steps, or no diagnostic structure.",
          }),
          criterion({
            id: "clarifying-questions",
            label: "Clarifying questions",
            description: "Agent gathers the environment and symptom details needed to diagnose.",
            maxScore: 5,
            excellent: "Agent collects relevant details (device, error messages, timeline) early.",
            poor: "Agent skips fact-finding and misdiagnoses the issue.",
          }),
        ],
      },
      {
        id: "guidance",
        title: "Guidance",
        criteria: [
          criterion({
            id: "clear-instructions",
            label: "Clear step-by-step instructions",
            description: "Instructions are easy to follow at the customer's technical level.",
            maxScore: 5,
            excellent: "Instructions paced to the customer's level, confirmed after each step.",
            poor: "Steps rushed, skipped, or delivered in jargon the customer cannot follow.",
          }),
        ],
      },
      {
        id: "resolution",
        title: "Resolution & escalation",
        criteria: [
          criterion({
            id: "resolution-verified",
            label: "Resolution verified",
            description: "Agent confirms the issue is actually fixed before closing.",
            maxScore: 5,
            weight: 2,
            excellent: "Agent tests/verifies the fix with the customer before ending the call.",
            poor: "Call closed without confirming the problem is solved.",
          }),
          criterion({
            id: "escalation-quality",
            label: "Escalation quality",
            description: "If escalated, the handoff includes full context and correct routing.",
            maxScore: 5,
            excellent: "Escalation includes findings so far, correct team, and customer expectations set.",
            poor: "Blind transfer with no context after lengthy troubleshooting.",
          }),
        ],
      },
    ],
  },
  {
    name: "AI Handoff Evaluation",
    slug: "ai-handoff-evaluation",
    description:
      "Evaluates AI-assistant-to-agent handoffs: context completeness, agent use of AI-collected data, and customer experience continuity.",
    category: "ai-handoff",
    sections: [
      {
        id: "handoff",
        title: "Handoff quality",
        criteria: [
          criterion({
            id: "context-used",
            label: "Agent used AI-collected context",
            description: "Agent reviewed the AI summary/slots instead of restarting from zero.",
            maxScore: 5,
            weight: 2,
            excellent: "Agent references the AI-collected details and continues seamlessly from where the assistant left off.",
            poor: "Agent ignores the handoff data entirely.",
          }),
          criterion({
            id: "no-repeated-questions",
            label: "No repeated questions",
            description: "Customer was not asked to repeat information already given to the AI assistant.",
            maxScore: 5,
            weight: 2,
            excellent: "No information the customer already provided is requested again.",
            poor: "Customer forced to repeat name, issue, and details already captured.",
          }),
        ],
      },
      {
        id: "experience",
        title: "Customer experience",
        criteria: [
          criterion({
            id: "smooth-transition",
            label: "Smooth transition",
            description: "The switch from AI to human felt continuous to the customer.",
            maxScore: 5,
            excellent: "Agent acknowledges the prior AI conversation and frames the transition naturally.",
            poor: "Jarring transition, customer confused about who they are talking to.",
          }),
          criterion({
            id: "resolution-outcome",
            label: "Resolution outcome",
            description: "The combined AI + agent interaction resolved the customer's request.",
            maxScore: 5,
            excellent: "Request fully resolved within the handed-off conversation.",
            poor: "Customer left unresolved despite the full AI + agent journey.",
          }),
        ],
      },
    ],
  },
];

export function buildQualityFormSchema(template) {
  return {
    sections: template.sections,
  };
}

export function computeQualityFormMaxScore(template) {
  let max = 0;
  for (const section of template.sections || []) {
    for (const item of section.criteria || []) {
      max += Number(item.maxScore || 0) * Number(item.weight || 1);
    }
  }
  return max;
}

export async function seedQualityForms() {
  const pool = getPostgresPool();
  if (!pool) {
    seedLogger.warn("seed_quality_forms_no_pool");
    return false;
  }

  try {
    for (const template of QUALITY_FORM_TEMPLATES) {
      const existing = await pool.query(
        "SELECT id FROM quality_forms WHERE slug = $1 LIMIT 1",
        [template.slug],
      );
      if (existing.rows.length > 0) continue;

      const schema = buildQualityFormSchema(template);
      const scoringConfig = {
        maxScore: computeQualityFormMaxScore(template),
        passThresholdPercent: 80,
        criticalFailZeroesScore: true,
      };
      const aiPromptConfig = {
        persona:
          "You are a strict but fair contact center quality analyst. Score only based on evidence found in the transcript.",
        language: "auto",
      };

      const inserted = await pool.query(
        `INSERT INTO quality_forms
           (name, slug, description, category, status, version, schema, scoring_config, ai_prompt_config, is_template, created_by, published_at)
         VALUES ($1, $2, $3, $4, 'published', 1, $5, $6, $7, true, 'system', NOW())
         RETURNING id`,
        [
          template.name,
          template.slug,
          template.description,
          template.category,
          JSON.stringify(schema),
          JSON.stringify(scoringConfig),
          JSON.stringify(aiPromptConfig),
        ],
      );

      const formId = inserted.rows?.[0]?.id;
      if (formId) {
        await pool.query(
          `INSERT INTO quality_form_versions (form_id, version, schema, scoring_config, ai_prompt_config, created_by)
           VALUES ($1, 1, $2, $3, $4, 'system')
           ON CONFLICT (form_id, version) DO NOTHING`,
          [
            formId,
            JSON.stringify(schema),
            JSON.stringify(scoringConfig),
            JSON.stringify(aiPromptConfig),
          ],
        );
      }
    }

    seedLogger.info("seed_quality_forms_completed");
    return true;
  } catch (error) {
    seedLogger.error("seed_quality_forms_failed");
    return false;
  }
}
