import assert from "node:assert/strict";
import test from "node:test";

import { campaignSaveRequirements } from "../lib/outbound-dialer/campaign-validation.js";

const baseCampaign = {
  name: "New campaign",
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
