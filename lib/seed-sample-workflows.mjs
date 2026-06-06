import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { getPostgresPool } from "./postgres.mjs";

const seedLogger = createDiagnosticLogger("app");

/**
 * Seed Sample Workflows
 * 
 * Creates sample workflows for different industries:
 * 1. Customer Support Call
 * 2. Sales Call
 * 3. Healthcare Intake (GMR-style)
 * 4. Survey/Feedback
 */

const SAMPLE_WORKFLOWS = [
// 1. Customer Support Call
{
  name: "Customer Support Call",
  description: "Standard workflow for customer support calls - guides agents through greeting, verification, and resolution.",
  category: "support",
  stages: [
  {
    name: "Opening",
    description: "Greet the customer and establish rapport",
    order_index: 0,
    items: [
    { type: "action", label: "Thank the customer for calling", prompt_hint: "thank you for calling, thanks for calling, welcome", order_index: 0 },
    { type: "action", label: "Introduce yourself by name", prompt_hint: "my name is, speaking with, this is, I'm", order_index: 1 },
    { type: "question", label: "Ask how you can help today", prompt_hint: "how can I help, what can I do for you, assist you", order_index: 2 }]

  },
  {
    name: "Verification",
    description: "Verify customer identity for account access",
    order_index: 1,
    items: [
    { type: "question", label: "Request permission to verify account", prompt_hint: "verify, confirm, security, may I have", order_index: 0 },
    { type: "slot", label: "Customer full name", prompt_hint: "my name is, name's, I am", slot_name: "customer_name", slot_type: "text", order_index: 1 },
    { type: "slot", label: "Account number or email", prompt_hint: "account number, email is, my email", slot_name: "account_id", slot_type: "text", order_index: 2 },
    { type: "slot", label: "Security verification (DOB/SSN last 4)", prompt_hint: "date of birth, birthday, last four", slot_name: "security_answer", slot_type: "text", order_index: 3 },
    { type: "action", label: "Confirm identity verified", prompt_hint: "verified, confirmed, thank you", order_index: 4 }]

  },
  {
    name: "Issue Identification",
    description: "Understand the customer's problem",
    order_index: 2,
    items: [
    { type: "topic", label: "Listen to customer's concern", prompt_hint: "problem, issue, need help, having trouble", order_index: 0 },
    { type: "slot", label: "Issue category", prompt_hint: "billing, technical, account, shipping, refund", slot_name: "issue_category", slot_type: "text", order_index: 1 },
    { type: "question", label: "Ask clarifying questions", prompt_hint: "can you tell me more, when did this start, what happened", order_index: 2 },
    { type: "action", label: "Summarize the issue back to customer", prompt_hint: "so what I understand, let me make sure, so you're saying", order_index: 3 }]

  },
  {
    name: "Resolution",
    description: "Provide solution to the customer",
    order_index: 3,
    items: [
    { type: "action", label: "Provide solution or workaround", prompt_hint: "here's what I can do, let me help, I'll fix", order_index: 0 },
    { type: "question", label: "Confirm solution is acceptable", prompt_hint: "does that work, is that okay, will that help", order_index: 1 },
    { type: "action", label: "Execute the resolution", prompt_hint: "I've done, completed, updated, fixed", order_index: 2 },
    { type: "question", label: "Verify issue is resolved", prompt_hint: "is everything working, did that solve, any other issues", order_index: 3 }]

  },
  {
    name: "Closing",
    description: "Wrap up the call professionally",
    order_index: 4,
    items: [
    { type: "question", label: "Ask if anything else is needed", prompt_hint: "anything else, other questions, more help", order_index: 0 },
    { type: "action", label: "Provide reference/ticket number if applicable", prompt_hint: "reference number, ticket, case number", order_index: 1 },
    { type: "action", label: "Thank customer for their time", prompt_hint: "thank you for calling, appreciate, have a great day", order_index: 2 }]

  }]

},

// 2. Sales Call
{
  name: "Sales Call",
  description: "Outbound or inbound sales call workflow - from needs discovery to closing the deal.",
  category: "sales",
  stages: [
  {
    name: "Opening",
    description: "Build rapport and set the stage",
    order_index: 0,
    items: [
    { type: "action", label: "Greet and introduce yourself", prompt_hint: "hello, hi, my name is, calling from", order_index: 0 },
    { type: "action", label: "State purpose of call", prompt_hint: "reason I'm calling, reaching out because, wanted to discuss", order_index: 1 },
    { type: "question", label: "Confirm this is a good time", prompt_hint: "is this a good time, do you have a moment, can we talk", order_index: 2 },
    { type: "action", label: "Build initial rapport", prompt_hint: "how are you, how's your day, nice to speak with you", order_index: 3 }]

  },
  {
    name: "Needs Discovery",
    description: "Understand customer needs and pain points",
    order_index: 1,
    items: [
    { type: "question", label: "Ask about current situation", prompt_hint: "tell me about, currently using, how do you handle", order_index: 0 },
    { type: "slot", label: "Current solution/provider", prompt_hint: "we use, currently have, our provider is", slot_name: "current_solution", slot_type: "text", order_index: 1 },
    { type: "question", label: "Identify pain points", prompt_hint: "challenges, frustrations, wish it could, biggest problem", order_index: 2 },
    { type: "slot", label: "Main pain point", prompt_hint: "biggest issue, main problem, frustrated with", slot_name: "pain_point", slot_type: "text", order_index: 3 },
    { type: "question", label: "Understand goals and priorities", prompt_hint: "looking for, goals, important to you, priorities", order_index: 4 },
    { type: "slot", label: "Budget range", prompt_hint: "budget, spending, invest, price range", slot_name: "budget", slot_type: "text", order_index: 5 },
    { type: "slot", label: "Timeline/urgency", prompt_hint: "when, timeline, deadline, urgently, soon", slot_name: "timeline", slot_type: "text", order_index: 6 }]

  },
  {
    name: "Product Presentation",
    description: "Present solution tailored to their needs",
    order_index: 2,
    items: [
    { type: "action", label: "Summarize their needs", prompt_hint: "based on what you told me, sounds like you need", order_index: 0 },
    { type: "action", label: "Present relevant features/benefits", prompt_hint: "our solution, what we offer, this will help you", order_index: 1 },
    { type: "action", label: "Share success stories/testimonials", prompt_hint: "other customers, similar situation, success with", order_index: 2 },
    { type: "action", label: "Explain pricing/packages", prompt_hint: "pricing, cost, investment, package, plan", order_index: 3 },
    { type: "question", label: "Check for understanding", prompt_hint: "does that make sense, any questions so far, clear", order_index: 4 }]

  },
  {
    name: "Objection Handling",
    description: "Address concerns and objections",
    order_index: 3,
    items: [
    { type: "topic", label: "Listen to objections/concerns", prompt_hint: "but, however, concerned about, not sure, too expensive", order_index: 0 },
    { type: "slot", label: "Primary objection", prompt_hint: "price, timing, need to think, talk to, competitor", slot_name: "objection", slot_type: "text", order_index: 1 },
    { type: "action", label: "Acknowledge the concern", prompt_hint: "I understand, that's a valid point, I hear you", order_index: 2 },
    { type: "action", label: "Provide counter-argument or solution", prompt_hint: "here's why, actually, what if I told you, we can", order_index: 3 },
    { type: "question", label: "Confirm objection is resolved", prompt_hint: "does that address, feel better about, make sense now", order_index: 4 }]

  },
  {
    name: "Close",
    description: "Close the deal or set next steps",
    order_index: 4,
    items: [
    { type: "question", label: "Trial close - gauge interest", prompt_hint: "how does this sound, ready to move forward, interested", order_index: 0 },
    { type: "action", label: "Present call to action", prompt_hint: "let's get started, sign up today, I can set up", order_index: 1 },
    { type: "slot", label: "Decision/commitment", prompt_hint: "yes, let's do it, sign me up, not right now, need to think", slot_name: "decision", slot_type: "text", order_index: 2 },
    { type: "action", label: "Confirm next steps", prompt_hint: "next step, I'll send, schedule, follow up", order_index: 3 },
    { type: "slot", label: "Follow-up date/time", prompt_hint: "call back, next week, tomorrow, follow up on", slot_name: "followup_date", slot_type: "text", order_index: 4 },
    { type: "action", label: "Thank and close professionally", prompt_hint: "thank you, appreciate your time, look forward to", order_index: 5 }]

  }]

},

// 3. Healthcare Intake (GMR-style)
{
  name: "Healthcare Intake (Air Ambulance)",
  description: "Medical transport intake workflow based on GMR requirements - caller ID, patient info, transport details.",
  category: "healthcare",
  stages: [
  {
    name: "Caller Identification",
    description: "Identify the caller and requesting facility",
    order_index: 0,
    items: [
    { type: "action", label: "Greet caller with brand name", prompt_hint: "hello, this is AirEvac, thank you for calling", order_index: 0 },
    { type: "slot", label: "Caller's name", prompt_hint: "my name is, this is, I'm, speaking", slot_name: "caller_name", slot_type: "text", order_index: 1 },
    { type: "slot", label: "Calling facility name", prompt_hint: "calling from, hospital, medical center, facility", slot_name: "caller_facility", slot_type: "text", order_index: 2 },
    { type: "slot", label: "Caller's department", prompt_hint: "emergency, ICU, CCU, ED, department", slot_name: "caller_department", slot_type: "text", order_index: 3 },
    { type: "slot", label: "Callback number", prompt_hint: "reach you at, callback, phone number, contact", slot_name: "callback_number", slot_type: "phone", order_index: 4 }]

  },
  {
    name: "Intent Identification",
    description: "Determine the purpose of the call",
    order_index: 1,
    items: [
    { type: "question", label: "Ask how to assist today", prompt_hint: "how can I help, what can I do, assist you with", order_index: 0 },
    { type: "slot", label: "Call intent", prompt_hint: "new transport, request flight, check status, ETA, cancel", slot_name: "intent", slot_type: "text", order_index: 1 },
    { type: "topic", label: "Confirm intent understood", prompt_hint: "so you need, requesting, want to check", order_index: 2 }]

  },
  {
    name: "Patient Information",
    description: "Collect patient demographics",
    order_index: 2,
    items: [
    { type: "slot", label: "Patient first and last name", prompt_hint: "patient name, patient is, transporting", slot_name: "patient_name", slot_type: "text", order_index: 0 },
    { type: "slot", label: "Patient date of birth", prompt_hint: "date of birth, DOB, born, birthday", slot_name: "patient_dob", slot_type: "date", order_index: 1 },
    { type: "slot", label: "Patient weight (lbs or kg)", prompt_hint: "weight, weighs, pounds, kilograms, kg, lbs", slot_name: "patient_weight", slot_type: "text", order_index: 2 },
    { type: "slot", label: "Patient gender", prompt_hint: "male, female, gender, he, she", slot_name: "patient_gender", slot_type: "text", order_index: 3 }]

  },
  {
    name: "Transport Details",
    description: "Collect pickup and destination information",
    order_index: 3,
    items: [
    { type: "slot", label: "Pickup facility name", prompt_hint: "pickup from, picking up at, origin, from hospital", slot_name: "pickup_facility", slot_type: "text", order_index: 0 },
    { type: "slot", label: "Pickup department/room", prompt_hint: "room, department, floor, bed", slot_name: "pickup_location", slot_type: "text", order_index: 1 },
    { type: "slot", label: "Destination facility name", prompt_hint: "going to, destination, transport to, receiving", slot_name: "destination_facility", slot_type: "text", order_index: 2 },
    { type: "slot", label: "Destination department", prompt_hint: "to department, destination room, receiving department", slot_name: "destination_department", slot_type: "text", order_index: 3 },
    { type: "slot", label: "Reason for transport", prompt_hint: "diagnosis, reason, condition, transferring for", slot_name: "transport_reason", slot_type: "text", order_index: 4 },
    { type: "slot", label: "Number of IV drips", prompt_hint: "IV, drip, infusion, how many IVs", slot_name: "iv_count", slot_type: "number", order_index: 5 },
    { type: "slot", label: "Special equipment needed", prompt_hint: "ventilator, oxygen, ECMO, balloon pump, equipment", slot_name: "special_equipment", slot_type: "text", order_index: 6 },
    { type: "slot", label: "Accompanying person", prompt_hint: "family member, nurse, someone accompanying", slot_name: "accompanying", slot_type: "boolean", order_index: 7 }]

  },
  {
    name: "Safety Questions",
    description: "Required safety verification",
    order_index: 4,
    items: [
    { type: "slot", label: "Any air service declined for weather?", prompt_hint: "weather, declined, another service, turned down", slot_name: "weather_declined", slot_type: "boolean", order_index: 0 },
    { type: "slot", label: "Other aircraft responding?", prompt_hint: "other aircraft, helicopter, another flight, responding", slot_name: "other_aircraft", slot_type: "boolean", order_index: 1 },
    { type: "slot", label: "Any isolation precautions?", prompt_hint: "isolation, COVID, precautions, PPE, infectious", slot_name: "isolation", slot_type: "boolean", order_index: 2 }]

  },
  {
    name: "Confirmation",
    description: "Confirm details and submit request",
    order_index: 5,
    items: [
    { type: "action", label: "Read back transport details", prompt_hint: "let me confirm, read back, verify details", order_index: 0 },
    { type: "question", label: "Confirm all information is correct", prompt_hint: "is that correct, anything to change, accurate", order_index: 1 },
    { type: "action", label: "Submit transport request", prompt_hint: "submitting, creating request, entered into system", order_index: 2 },
    { type: "action", label: "Provide confirmation/reference number", prompt_hint: "confirmation number, reference, request number", order_index: 3 },
    { type: "action", label: "Explain next steps and ETA", prompt_hint: "dispatch, ETA, expect, next steps", order_index: 4 },
    { type: "action", label: "Thank caller and close", prompt_hint: "thank you, anything else, goodbye", order_index: 5 }]

  }]

},

// 4. Survey/Feedback
{
  name: "Customer Survey",
  description: "Post-interaction customer satisfaction survey workflow.",
  category: "survey",
  stages: [
  {
    name: "Introduction",
    description: "Introduce the survey and get consent",
    order_index: 0,
    items: [
    { type: "action", label: "Greet and introduce survey purpose", prompt_hint: "hello, quick survey, feedback, few questions", order_index: 0 },
    { type: "action", label: "Explain survey length (e.g., 2 minutes)", prompt_hint: "take about, only a few minutes, quick", order_index: 1 },
    { type: "question", label: "Ask for consent to proceed", prompt_hint: "would you mind, willing to, can I ask", order_index: 2 }]

  },
  {
    name: "Questions",
    description: "Survey questions",
    order_index: 1,
    items: [
    { type: "slot", label: "Overall satisfaction (1-5)", prompt_hint: "rate, overall, satisfied, scale of 1 to 5", slot_name: "overall_rating", slot_type: "number", order_index: 0 },
    { type: "slot", label: "Agent helpfulness (1-5)", prompt_hint: "agent, representative, helpful, rate the agent", slot_name: "agent_rating", slot_type: "number", order_index: 1 },
    { type: "slot", label: "Issue resolved? (Yes/No)", prompt_hint: "resolved, solved, fixed, taken care of", slot_name: "issue_resolved", slot_type: "boolean", order_index: 2 },
    { type: "slot", label: "Likelihood to recommend (1-10 NPS)", prompt_hint: "recommend, NPS, tell a friend, scale of 1 to 10", slot_name: "nps_score", slot_type: "number", order_index: 3 },
    { type: "slot", label: "What could we improve?", prompt_hint: "improve, better, suggestion, feedback", slot_name: "improvement_feedback", slot_type: "text", order_index: 4 },
    { type: "slot", label: "Additional comments", prompt_hint: "anything else, comments, add, share", slot_name: "additional_comments", slot_type: "text", order_index: 5 }]

  },
  {
    name: "Thank You",
    description: "Close the survey",
    order_index: 2,
    items: [
    { type: "action", label: "Thank for participation", prompt_hint: "thank you, appreciate, valuable feedback", order_index: 0 },
    { type: "action", label: "Explain how feedback will be used", prompt_hint: "help us improve, use your feedback, make changes", order_index: 1 },
    { type: "action", label: "Close with appreciation", prompt_hint: "have a great day, goodbye, thank you again", order_index: 2 }]

  }]

}];


export async function seedSampleWorkflows() {
  const pool = getPostgresPool();
  if (!pool) {
    seedLogger.warn("seed_workflows_db_unavailable");
    return { created: 0, skipped: 0 };
  }

  const client = await pool.connect();
  let createdCount = 0;
  let skippedCount = 0;

  try {
    for (const workflowData of SAMPLE_WORKFLOWS) {
      await client.query("BEGIN");

      // Check if workflow already exists
      const { rows: existing } = await client.query(
        `SELECT id FROM aa_workflows WHERE name = $1`,
        [workflowData.name]
      );

      if (existing.length > 0) {
        await client.query("ROLLBACK");
        skippedCount++;
        continue;
      }

      // Create workflow
      const { rows: [workflow] } = await client.query(
        `INSERT INTO aa_workflows (name, description, category, is_active)
         VALUES ($1, $2, $3, true)
         RETURNING *`,
        [workflowData.name, workflowData.description, workflowData.category]
      );

      // Create stages
      for (const stageData of workflowData.stages) {
        const { rows: [stage] } = await client.query(
          `INSERT INTO aa_workflow_stages (workflow_id, name, description, order_index, is_required)
           VALUES ($1, $2, $3, $4, true)
           RETURNING *`,
          [workflow.id, stageData.name, stageData.description, stageData.order_index]
        );

        // Create items for this stage
        for (const itemData of stageData.items) {
          await client.query(
            `INSERT INTO aa_workflow_items 
             (stage_id, type, label, prompt_hint, order_index, is_required,
              slot_name, slot_type)
             VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
            [
            stage.id,
            itemData.type,
            itemData.label,
            itemData.prompt_hint,
            itemData.order_index,
            itemData.slot_name || null,
            itemData.slot_type || null]

          );
        }
      }

      await client.query("COMMIT");
      createdCount++;
      seedLogger.info("seed_workflows_created");
    }

    if (createdCount > 0 || skippedCount > 0) {
      seedLogger.info("seed_workflows_complete", { created: createdCount, skipped: skippedCount });
    }

    return { created: createdCount, skipped: skippedCount };
  } catch (error) {
    await client.query("ROLLBACK");
    seedLogger.error("seed_workflows_failed");
    throw error;
  } finally {
    client.release();
  }
}
