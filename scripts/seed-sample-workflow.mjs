/**
 * Seed Sample Workflow Script
 * 
 * Creates a sample "Customer Support Call" workflow with 3 stages
 * for demonstration and testing purposes.
 * 
 * Usage: node scripts/seed-sample-workflow.mjs
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { getPostgresPool } from "../lib/postgres.mjs";

const SAMPLE_WORKFLOW = {
  name: "Customer Support Call",
  description: "Standard workflow for customer support calls - guides agents through greeting, verification, and resolution.",
  category: "support",
  stages: [
    {
      name: "Call Opening",
      description: "Greet the customer and establish rapport",
      order_index: 0,
      items: [
        {
          type: "action",
          label: "Thank the customer for calling",
          prompt_hint: "thank you for calling, thanks for calling, welcome",
          order_index: 0,
        },
        {
          type: "action",
          label: "Introduce yourself",
          prompt_hint: "my name is, speaking with, this is, I'm",
          order_index: 1,
        },
        {
          type: "question",
          label: "Ask how you can help today",
          prompt_hint: "how can I help, what can I do for you, assist you, help you with",
          order_index: 2,
        },
        {
          type: "topic",
          label: "Listen to customer's initial concern",
          prompt_hint: "problem, issue, question, need help, having trouble",
          order_index: 3,
        },
      ],
    },
    {
      name: "Verification",
      description: "Verify customer identity for account access",
      order_index: 1,
      items: [
        {
          type: "question",
          label: "Ask for permission to verify account details",
          prompt_hint: "verify, confirm, security, account details, can I have",
          order_index: 0,
        },
        {
          type: "slot",
          label: "Customer full name",
          prompt_hint: "my name is, name's, speaking with, I am",
          slot_name: "customer_name",
          slot_type: "text",
          order_index: 1,
        },
        {
          type: "slot",
          label: "Account number or email",
          prompt_hint: "account number, account is, email is, my email",
          slot_name: "account_identifier",
          slot_type: "text",
          order_index: 2,
        },
        {
          type: "slot",
          label: "Verification answer (last 4 SSN, DOB, or security question)",
          prompt_hint: "date of birth, birthday, social, last four, security answer",
          slot_name: "verification_answer",
          slot_type: "text",
          order_index: 3,
        },
        {
          type: "action",
          label: "Confirm identity verified",
          prompt_hint: "verified, confirmed, thank you for verifying, account confirmed",
          order_index: 4,
        },
      ],
    },
    {
      name: "Resolution",
      description: "Address the customer's issue and close the call",
      order_index: 2,
      items: [
        {
          type: "topic",
          label: "Understand the specific issue",
          prompt_hint: "understand, got it, I see, so you're saying, the issue is",
          order_index: 0,
        },
        {
          type: "slot",
          label: "Issue category",
          prompt_hint: "billing, technical, account, shipping, refund, password, login",
          slot_name: "issue_category",
          slot_type: "text",
          order_index: 1,
        },
        {
          type: "action",
          label: "Provide solution or next steps",
          prompt_hint: "here's what I can do, let me help, I'll, solution, fix this",
          order_index: 2,
        },
        {
          type: "question",
          label: "Ask if solution resolves the issue",
          prompt_hint: "does that help, work for you, solve, anything else",
          order_index: 3,
        },
        {
          type: "question",
          label: "Ask if there's anything else",
          prompt_hint: "anything else, other questions, further assistance, more help",
          order_index: 4,
        },
        {
          type: "action",
          label: "Thank customer and close call",
          prompt_hint: "thank you for calling, have a great day, goodbye, take care",
          order_index: 5,
        },
      ],
    },
  ],
};

async function seedSampleWorkflow() {
  console.log("[Seed] Starting sample workflow creation...");
  
  const pool = getPostgresPool();
  if (!pool) {
    console.error("[Seed] Database pool not available");
    process.exit(1);
  }

  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");

    // Check if workflow already exists
    const { rows: existing } = await client.query(
      `SELECT id FROM aa_workflows WHERE name = $1`,
      [SAMPLE_WORKFLOW.name]
    );

    if (existing.length > 0) {
      console.log("[Seed] Sample workflow already exists, skipping...");
      await client.query("ROLLBACK");
      return;
    }

    // Create workflow
    const { rows: [workflow] } = await client.query(
      `INSERT INTO aa_workflows (name, description, category, is_active)
       VALUES ($1, $2, $3, true)
       RETURNING *`,
      [SAMPLE_WORKFLOW.name, SAMPLE_WORKFLOW.description, SAMPLE_WORKFLOW.category]
    );

    console.log(`[Seed] Created workflow: ${workflow.name} (${workflow.id})`);

    // Create stages
    for (const stageData of SAMPLE_WORKFLOW.stages) {
      const { rows: [stage] } = await client.query(
        `INSERT INTO aa_workflow_stages (workflow_id, name, description, order_index, is_required)
         VALUES ($1, $2, $3, $4, true)
         RETURNING *`,
        [workflow.id, stageData.name, stageData.description, stageData.order_index]
      );

      console.log(`[Seed]   Created stage: ${stage.name}`);

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
            itemData.slot_type || null,
          ]
        );
      }

      console.log(`[Seed]     Created ${stageData.items.length} items`);
    }

    await client.query("COMMIT");
    console.log("[Seed] Sample workflow created successfully!");
    console.log(`[Seed] Workflow ID: ${workflow.id}`);
    
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[Seed] Error creating sample workflow:", error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the seeder
seedSampleWorkflow()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
