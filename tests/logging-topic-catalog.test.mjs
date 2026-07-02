import assert from "node:assert/strict";
import { test } from "node:test";

const moduleUrl = new URL("../lib/logger/topic-catalog.mjs", import.meta.url).href;

async function freshCatalog() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

test("logging topic catalog exposes the approved two-level group taxonomy", async () => {
  const {
    LOGGING_TOPIC_GROUPS,
    flattenLoggingTopics,
    defaultTopicLevelsFromCatalog,
    defaultTopicEnabledFromCatalog,
    topicGroupForTopic,
    canonicalTopicFor,
    LEGACY_TOPIC_ALIASES,
  } = await freshCatalog();

  assert.equal(LOGGING_TOPIC_GROUPS.length, 9);
  const groupIds = LOGGING_TOPIC_GROUPS.map((group) => group.id);
  assert.deepEqual(groupIds, [
    "platform",
    "security",
    "contact-center",
    "voice",
    "telnyx",
    "agent-assist",
    "outbound",
    "supervisor",
    "notifications",
  ]);

  const topics = flattenLoggingTopics();
  assert.equal(topics.length, 48);
  assert.equal(new Set(topics.map((topic) => topic.id)).size, topics.length);
  for (const topic of topics) {
    assert.match(topic.id, /^[a-z0-9-]+\.[a-z0-9-]+$/);
    assert.ok(groupIds.includes(topic.groupId), `${topic.id} has known group`);
    assert.ok(topic.label, `${topic.id} has label`);
    assert.ok(topic.description, `${topic.id} has description`);
    assert.equal(topicGroupForTopic(topic.id)?.id, topic.groupId);
  }

  const levels = defaultTopicLevelsFromCatalog();
  const enabled = defaultTopicEnabledFromCatalog();
  for (const groupId of groupIds) {
    assert.equal(levels[groupId], undefined, `${groupId} must not be persisted as a topic level`);
    assert.equal(enabled[groupId], undefined, `${groupId} must not be persisted as a topic enabled flag`);
  }
  assert.equal(levels["platform.db"], "warn");
  assert.equal(levels["platform.phone-provisioning"], "info");
  assert.equal(levels["telnyx.media"], "warn");
  assert.equal(levels["agent-assist.llm"], "warn");
  assert.equal(enabled["contact-center.routing"], true);
  assert.equal(levels["frontend"], undefined);
  assert.equal(enabled["frontend.agent-desktop"], undefined);

  assert.equal(LEGACY_TOPIC_ALIASES["telnyx.webhook"], "telnyx.webhooks");
  assert.equal(canonicalTopicFor("voice-flow"), "voice.flow");
  assert.equal(canonicalTopicFor("telnyx.stt.media"), "telnyx.media");
  assert.equal(canonicalTopicFor("contact-center.routing"), "contact-center.routing");
});

test("runtime config defaults are derived from canonical topic catalog", async () => {
  const runtime = await import(`../lib/logger/runtime-config.mjs?t=${Date.now()}-${Math.random()}`);

  assert.equal(runtime.DEFAULT_TOPIC_LEVELS["platform.app"], "info");
  assert.equal(runtime.DEFAULT_TOPIC_LEVELS["platform.db"], "warn");
  assert.equal(runtime.DEFAULT_TOPIC_LEVELS["platform.phone-provisioning"], "info");
  assert.equal(runtime.DEFAULT_TOPIC_LEVELS["security.auth"], "info");
  assert.equal(runtime.DEFAULT_TOPIC_LEVELS["voice.webhooks"], "info");
  assert.equal(runtime.DEFAULT_TOPIC_LEVELS["telnyx.media"], "warn");
  assert.equal(runtime.DEFAULT_TOPIC_LEVELS["agent-assist.llm"], "warn");
  assert.equal(runtime.DEFAULT_TOPIC_ENABLED["contact-center.transfer"], true);

  const config = runtime.normalizeRuntimeLoggingConfig({
    topicLevels: { app: "debug", "platform.phone-provisioning": "debug", "telnyx.stt.media": "trace", "voice-flow": "warn" },
    topicEnabled: { auth: false, "outbound-dialer": false },
  });

  assert.equal(config.topicLevels["platform.app"], "debug");
  assert.equal(config.topicLevels["platform.phone-provisioning"], "debug");
  assert.equal(config.topicLevels["telnyx.media"], "trace");
  assert.equal(config.topicLevels["voice.flow"], "warn");
  assert.equal(config.topicEnabled["security.auth"], false);
  assert.equal(config.topicEnabled["outbound.campaigns"], false);
});
