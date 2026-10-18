import test from "node:test";
import assert from "node:assert/strict";
import { UI_LOCALES, isUiLocale, normalizeUiLocale, localeDirection, messageId } from "../lib/i18n/locales.mjs";
import { loadRoute } from "./helpers/route-harness.mjs";
import fs from 'node:fs';
import { DEFAULT_AGENT_STATUSES, statusLabel, statusDescription } from '../lib/i18n/status-labels.mjs';
import { interactionStateLabel, operationalStatusLabel } from '../lib/i18n/interaction-labels.mjs';
import { toIcuMessage, protectedTokens, isCodeExample } from '../lib/i18n/catalogue-text.mjs';
import { parse as parseMessage } from '@formatjs/icu-messageformat-parser';
test("UI locale validation accepts only the eight released variants", () => {
  assert.equal(UI_LOCALES.length, 8);
  for (const {
    id
  } of UI_LOCALES) {
    assert(isUiLocale(id));
    assert.equal(normalizeUiLocale(id), id);
  }
  for (const invalid of [null, "", "pl", "de-de", "../../secrets", {}, "ar-SA"]) {
    assert.equal(isUiLocale(invalid), false);
    assert.equal(normalizeUiLocale(invalid), "en-US");
  }
  assert.equal(localeDirection("ar-SA"), "rtl");
  assert.equal(localeDirection("he-IL"), "rtl");
  assert.equal(localeDirection("pl-PL"), "ltr");
});
test('technical examples remain distinct from interpolation and natural-language copy', () => {
  assert.deepEqual(protectedTokens('Use {{first_name}}, {field.key}, {value0}, https://example.test/a, sip:user@domain and replies@example.com.'),
    ['https://example.test/a', 'replies@example.com', 'sip:user@domain', '{field.key}', '{{first_name}}'].sort());
  assert.notDeepEqual(protectedTokens('{{variable}}'), protectedTokens('{{zmienna}}'));
  assert(isCodeExample('{"method":"GET","headers":{"Accept":"application/json"}}'));
  assert(isCodeExample('save_data'));
  assert(!isCodeExample('Save changes'));
});
async function profileFixture({
  authenticated = true
} = {}) {
  const user = {
    id: "locale-test-user",
    username: "locale@example.test",
    language: "en-US",
    ui_locale: "de-DE",
    theme: "system"
  };
  const writes = [],
    cookies = [];
  const route = await loadRoute("app/actions/user.js", {
    "next-auth": {
      getServerSession: async () => authenticated ? {
        user: {
          id: user.id
        }
      } : null
    },
    "@/app/api/auth/[...nextauth]/route": {
      authOptions: {}
    },
    "next/headers": {
      cookies: async () => ({
        set: (...args) => cookies.push(args)
      })
    },
    "next/cache": {
      revalidatePath() {}
    },
    "@/lib/pgdb": {
      PgDb: {
        findUserById: async () => user,
        updateUserById: async (id, update) => {
          writes.push({
            id,
            update
          });
          Object.assign(user, update);
        }
      }
    },
    "@/lib/postgres.mjs": {
      getPostgresPool: () => ({})
    },
    "@/lib/acd/agent-state.mjs": {
      readEffectiveAgentStatus: async () => "Available"
    }
  });
  return {
    route,
    user,
    writes,
    cookies
  };
}
test("saving a UI preference affects only the authenticated user and preserves speech language", async () => {
  const {
    route,
    user,
    writes,
    cookies
  } = await profileFixture();
  const form = new FormData();
  form.set("uiLocale", "pl-PL");
  form.set("userId", "someone-else");
  assert.equal((await route.updateProfileAction(form)).ok, true);
  assert.deepEqual(writes, [{
    id: user.id,
    update: {
      ui_locale: "pl-PL"
    }
  }]);
  assert.equal(user.language, "en-US");
  assert.equal(cookies[0][0], "cc_ui_locale");
  assert.equal(cookies[0][1], "pl-PL");
  assert.equal((await route.getProfileAction()).user.uiLocale, "pl-PL");
});
test("invalid preferences and unauthenticated writes leave stored preferences unchanged", async () => {
  const {
    route,
    writes,
    cookies
  } = await profileFixture();
  const form = new FormData();
  form.set("uiLocale", "../../private");
  assert.equal((await route.updateProfileAction(form)).code, "INVALID_UI_LOCALE");
  assert.deepEqual(writes, []);
  assert.deepEqual(cookies, []);
  const anonymous = await profileFixture({
    authenticated: false
  });
  form.set("uiLocale", "fr-FR");
  assert.equal((await anonymous.route.updateProfileAction(form)).ok, false);
  assert.deepEqual(anonymous.writes, []);
});
test("legacy profile saves do not reset the independent UI preference", async () => {
  const {
    route,
    user
  } = await profileFixture();
  const form = new FormData();
  form.set("nick", "Agent");
  form.set("language", "pl-PL");
  assert.equal((await route.updateProfileAction(form)).ok, true);
  assert.equal(user.ui_locale, "de-DE");
  assert.equal(user.language, "pl-PL");
});
test("source IDs are stable and case sensitive", () => {
  assert.equal(messageId("Save"), messageId("Save"));
  assert.notEqual(messageId("Save"), messageId("save"));
  assert.equal(messageId('Save'), 'm4d2d5d68');
  assert.notEqual(messageId('Call'), messageId('Call', 'phone action'));
  assert.notEqual(messageId('Open', 'action'), messageId('Open', 'state'));
});
test('literal templates, code, apostrophes and interpolation survive ICU rendering', () => {
  for (const text of ['{{customer_name}}', "Customer's {{name}}", '{{{value0}}}', '<code>{value0}</code>', '{"key":"{{value}}"}', "'{foo}' {value0}"]) {
    const rendered = parseMessage(toIcuMessage(text)).map(node => node.type === 0 ? node.value : `{${node.value}}`).join('');
    assert.equal(rendered, text);
  }
});
test('all database-seeded agent statuses and descriptions have display localization', () => {
  const schema = fs.readFileSync('lib/postgres-schema.mjs', 'utf8');
  const seed = schema.slice(schema.indexOf('// Seed default statuses'), schema.indexOf('ON CONFLICT (name) DO UPDATE', schema.indexOf('// Seed default statuses')));
  const seededNames = [...seed.matchAll(/\('[^']+', '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(DEFAULT_AGENT_STATUSES.map(status => status.name), seededNames);
  const translated = text => `localized:${text}`;
  for (const status of DEFAULT_AGENT_STATUSES) {
    assert.equal(statusLabel(translated, status.name), `localized:${status.name}`);
    assert.equal(statusDescription(translated, status.description), `localized:${status.description}`);
  }
  assert.equal(statusLabel(translated, 'Training for client A'), 'Training for client A');
  assert.equal(statusDescription(translated, 'Custom English description'), 'Custom English description');
  assert.equal(statusLabel(translated, undefined), undefined);
  assert.equal(interactionStateLabel(translated, 'held'), 'localized:On Hold');
  assert.equal(interactionStateLabel(translated, 'queued'), 'localized:Queued');
  assert.equal(operationalStatusLabel(translated, 'custom_state'), 'custom_state');
});
