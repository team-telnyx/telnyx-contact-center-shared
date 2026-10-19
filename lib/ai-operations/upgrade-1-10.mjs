// Historical values belong only to this one-time upgrade, never to request-time
// model resolution. Persist them as editable settings so 1.9 installations keep
// working without a mandatory manual conversion.
const GPT = "openai/gpt-4o";
const LLAMA = "meta-llama/Llama-3.3-70B-Instruct";
const LEGACY_MODELS = {
  "reply-suggestions": LLAMA,
  "kb-response": GPT,
  "workflow-analysis": GPT,
  "workflow-suggestion": GPT,
  "sentiment-intent": GPT,
  "live-translation": GPT,
  "quality-evaluation": LLAMA,
  "call-summary": GPT,
  "email-template": "Qwen/Qwen3-235B-A22B",
  "form-builder": "meta-llama/Meta-Llama-3.1-8B-Instruct",
  "assistant-summary": LLAMA,
  "preview-translation": LLAMA,
  "test-scenario": GPT,
  "test-caller": GPT,
  "voice-sample": GPT,
};
const LEGACY_ENV = {
  "live-translation": ["TELNYX_AI_TRANSLATION_MODEL"],
  "form-builder": ["FORM_BUILDER_AI_MODEL", "TELNYX_CHAT_MODEL"],
  "assistant-summary": ["TELNYX_AI_DASHBOARD_SUMMARY_MODEL"],
  "preview-translation": ["TELNYX_TRANSLATION_MODEL"],
};
const text = (value) => typeof value === "string" ? value.trim() : "";

export function legacyAiSettings(settings, env = process.env) {
  // An administrator who has already adopted the new default keeps its
  // inheritance semantics, including deliberately cleared operation models.
  if (text(settings.ai_default_model) || text(env.TELNYX_AI_DEFAULT_MODEL)) return settings;
  const next = structuredClone(settings);
  next.ai_default_model = GPT;
  next.ai_operations ||= {};
  for (const [id, oldDefault] of Object.entries(LEGACY_MODELS)) {
    const config = next.ai_operations[id] || {};
    if (text(config.model)) continue;
    const envModel = (LEGACY_ENV[id] || []).map((name) => text(env[name])).find(Boolean);
    next.ai_operations[id] = { ...config, model: envModel || oldDefault };
  }
  return next;
}

// Caller owns the schema transaction and its advisory lock. The marker is
// separate from editable settings so Apply to all / clearing never reruns this.
export async function upgradeAiModelSettings(client, { existingInstallation, env = process.env }) {
  await client.query(`CREATE TABLE IF NOT EXISTS cc_upgrade_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = await client.query(`INSERT INTO cc_upgrade_migrations (name)
    VALUES ('ai-model-settings-1.10.0') ON CONFLICT DO NOTHING RETURNING name`);
  if (!applied.rowCount || !existingInstallation) return;
  await client.query("INSERT INTO app_settings (id) VALUES ('default') ON CONFLICT DO NOTHING");
  const result = await client.query("SELECT cc_settings FROM app_settings WHERE id='default' FOR UPDATE");
  const settings = result.rows[0].cc_settings || {};
  const next = legacyAiSettings(settings, env);
  if (next !== settings) {
    await client.query("UPDATE app_settings SET cc_settings=$1::jsonb, updated_at=now() WHERE id='default'", [JSON.stringify(next)]);
  }
}

export async function ensureWorkflowModelColumns(client) {
  // Old defaults may also have been explicit administrator choices. Removing
  // a column default is safe; clearing matching stored values is not.
  await client.query(`ALTER TABLE aa_workflows
    ADD COLUMN IF NOT EXISTS llm_model VARCHAR(100),
    ADD COLUMN IF NOT EXISTS llm_fallback_model VARCHAR(100)`);
  await client.query(`ALTER TABLE aa_workflows
    ALTER COLUMN llm_model DROP DEFAULT,
    ALTER COLUMN llm_fallback_model DROP DEFAULT,
    ALTER COLUMN llm_fallback_model DROP NOT NULL`);
}
