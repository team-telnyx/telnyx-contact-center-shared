import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildContactDynamicVariablesResponse,
  clampContactMemoryLimit,
  contactToDynamicVariables,
  extractDynamicVariablesTarget,
  normalizeContactTarget,
} from "../lib/ai/contact-dynamic-variables.mjs";

const root = new URL("../", import.meta.url);

test("Contacts is the only predefined Dynamic Variables data source", async () => {
  const source = await readFile(new URL("components/assistants/IntegrationsTab.jsx", root), "utf8");
  assert.match(source, /<SelectItem value="contacts">Contacts<\/SelectItem>/);
  assert.doesNotMatch(source, /<SelectItem value="customers">Customers<\/SelectItem>/);
  assert.doesNotMatch(source, /<SelectItem value="patients">Patients<\/SelectItem>/);
  assert.match(source, /\/api\/contacts\/dynamic-variables\/\$\{limit\}/);
});

test("contact webhook payload follows the Telnyx dynamic variables contract", () => {
  const contact = {
    id: "contact-123",
    first_name: "Ada",
    last_name: "Lovelace",
    display_name: "Ada Lovelace",
    company_name: "Analytical Engines",
    phone: "+1 555 123 4567",
    notes: null,
  };
  assert.deepEqual(contactToDynamicVariables(contact), {
    contact_id: "contact-123",
    first_name: "Ada",
    last_name: "Lovelace",
    full_name: "Ada Lovelace",
    display_name: "Ada Lovelace",
    company_name: "Analytical Engines",
    phone: "+1 555 123 4567",
  });

  assert.deepEqual(
    buildContactDynamicVariablesResponse({ contact, target: "+15551234567", limit: 3 }),
    {
      dynamic_variables: contactToDynamicVariables(contact),
      memory: {
        conversation_query:
          "metadata->contact_id=eq.contact-123&limit=3&order=last_message_at.desc",
      },
      conversation: {
        metadata: {
          telnyx_end_user_target: "+15551234567",
          contact_id: "contact-123",
        },
      },
    }
  );
});

test("contact dynamic variables helpers validate initialization and lookup targets", () => {
  assert.equal(clampContactMemoryLimit(99), 5);
  assert.equal(clampContactMemoryLimit(0), 1);
  assert.equal(
    extractDynamicVariablesTarget({
      data: {
        event_type: "assistant.initialization",
        payload: { telnyx_end_user_target: "+48 602 410 402" },
      },
    }),
    "+48 602 410 402"
  );
  assert.equal(extractDynamicVariablesTarget({ data: { event_type: "other" } }), "");
  assert.deepEqual(normalizeContactTarget("+48 602-410-402"), {
    raw: "+48 602-410-402",
    email: "",
    digits: "48602410402",
  });
  assert.deepEqual(normalizeContactTarget("Ada@Example.com"), {
    raw: "Ada@Example.com",
    email: "ada@example.com",
    digits: "",
  });
});

test("Contacts dynamic variables endpoint accepts signed Telnyx webhooks or the AI API key", async () => {
  const source = await readFile(
    new URL("app/api/contacts/dynamic-variables/[limit]/route.js", root),
    "utf8"
  );
  assert.match(source, /requireAiApiKey\(request\)/);
  assert.match(source, /verifyTelnyxSignature\(request, rawBody\)/);
  assert.match(source, /buildContactDynamicVariablesResponse/);
  assert.match(source, /FROM contacts/);
});
