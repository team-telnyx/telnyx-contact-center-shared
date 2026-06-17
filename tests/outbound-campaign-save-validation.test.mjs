import assert from "node:assert/strict";
import test from "node:test";

import { campaignSaveRequirements } from "../lib/outbound-dialer/campaign-validation.js";

const baseCampaign = {
  name: "New campaign",
  mode: "preview",
  handler_type: "queue",
  handler_ref: "queue-1",
  contact_list_id: "list-1",
  metadata: {
    contact_list_numbers: ["Number"],
    rotate_numbers: false,
    from_numbers: ["+48602410402"],
  },
  retry_policy: { maxAttempts: 4 },
};

test("new campaign save requires contact list and contact list number fields", () => {
  assert.equal(campaignSaveRequirements({ ...baseCampaign, contact_list_id: null }).canSave, false);
  assert.deepEqual(campaignSaveRequirements({ ...baseCampaign, contact_list_id: null }).missing, ["contact_list"]);

  const withoutContactNumbers = {
    ...baseCampaign,
    metadata: { ...baseCampaign.metadata, contact_list_numbers: [] },
  };
  assert.equal(campaignSaveRequirements(withoutContactNumbers).canSave, false);
  assert.deepEqual(campaignSaveRequirements(withoutContactNumbers).missing, ["contact_list_numbers"]);
});

test("new campaign save requires default FROM slot when rotation is off", () => {
  const draft = {
    ...baseCampaign,
    metadata: { ...baseCampaign.metadata, rotate_numbers: false, from_numbers: [] },
    retry_policy: { maxAttempts: 4 },
  };

  const requirements = campaignSaveRequirements(draft, { maxAttempts: 4 });

  assert.equal(requirements.canSave, false);
  assert.deepEqual(requirements.missing, ["from_default"]);
});

test("new campaign save requires default and every retry FROM slot when rotation is on", () => {
  const draft = {
    ...baseCampaign,
    metadata: { ...baseCampaign.metadata, rotate_numbers: true, from_numbers: ["+48602410402", "+48602410403"] },
    retry_policy: { maxAttempts: 4 },
  };

  const requirements = campaignSaveRequirements(draft, { maxAttempts: 4 });

  assert.equal(requirements.canSave, false);
  assert.deepEqual(requirements.missing, ["from_retry_2", "from_retry_3"]);

  const complete = campaignSaveRequirements({
    ...draft,
    metadata: { ...draft.metadata, from_numbers: ["+48602410402", "+48602410403", "+48602410404", "+48602410405"] },
  }, { maxAttempts: 4 });
  assert.equal(complete.canSave, true);
  assert.deepEqual(complete.missing, []);
});

test("new campaign save caps required rotating FROM slots to runtime rotation limit", () => {
  const draft = {
    ...baseCampaign,
    metadata: {
      ...baseCampaign.metadata,
      rotate_numbers: true,
      from_numbers: ["+48602410402", "+48602410403", "+48602410404", "+48602410405", "+48602410406"],
    },
    retry_policy: { maxAttempts: 8 },
  };

  const requirements = campaignSaveRequirements(draft, { maxAttempts: 8 });

  assert.equal(requirements.requiredFromSlots, 5);
  assert.equal(requirements.canSave, true);
  assert.deepEqual(requirements.missing, []);
});

test("campaign save requires a Reference matching the selected mode", () => {
  const missingQueueReference = campaignSaveRequirements({
    ...baseCampaign,
    mode: "power",
    handler_type: "queue",
    handler_ref: "",
  });
  assert.equal(missingQueueReference.canSave, false);
  assert.ok(missingQueueReference.missing.includes("handler_ref"));

  const missingAiReference = campaignSaveRequirements({
    ...baseCampaign,
    mode: "agentless_ai",
    handler_type: "ai_assistant",
    handler_ref: "",
  });
  assert.equal(missingAiReference.canSave, false);
  assert.ok(missingAiReference.missing.includes("handler_ref"));

  const completeAiReference = campaignSaveRequirements({
    ...baseCampaign,
    mode: "agentless_ai",
    handler_type: "ai_assistant",
    handler_ref: "assistant-1",
  });
  assert.equal(completeAiReference.canSave, true);
  assert.deepEqual(completeAiReference.missing, []);
});
