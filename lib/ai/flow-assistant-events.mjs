import { assistantInvitePolicy, validateFlowAssistantInvites } from "./assistant-invite-policy.mjs";
import { assistantEventConfig, assertAssistantEventDestinations, assertAssistantEventWriteAccess, configureAssistantEvents, restoreAssistantEventChanges } from "./assistant-event-config.mjs";
import { ASSISTANT_EVENT_DESTINATION_CONFLICT } from "./assistant-event-conflicts.mjs";
import { getAssistantConfigurationPool } from "../postgres.mjs";
import { isPostgresConnectionFailure } from "../postgres-resilience.mjs";

// Called by flow create/update/import before persisting a new configuration.
// Validate every selection before changing any shared provider resource.
export async function prepareFlowAssistantInvites(nodes, request, { config, confirmations = [], canUpdateAssistant = false, changes } = {}) {
  const assistants = await validateFlowAssistantInvites(nodes, request);
  const receiver = assistants.length ? config || assistantEventConfig() : null;
  assertAssistantEventWriteAccess(assistants, receiver, canUpdateAssistant);
  assertAssistantEventDestinations(assistants, receiver, confirmations);
  for (const assistant of assistants) {
    try { await configureAssistantEvents(assistant, { request, config: receiver, confirmations, canUpdateAssistant, changes }); }
    catch (error) {
      if (error.code === ASSISTANT_EVENT_DESTINATION_CONFLICT) throw error;
      throw Object.assign(new Error(`Could not prepare live transcription for ${assistant.name || assistant.id}. The call flow was not saved. ${error.message}`), { status: error.status || 503 });
    }
  }
  const names = new Map(assistants.map(assistant => [assistant.id, assistant.name || assistant.id]));
  return (nodes || []).map(node => {
    if (node.data?.nodeType !== "agent_assist") return node;
    const policy = assistantInvitePolicy(node.data.config);
    return { ...node, data: { ...node.data, config: { ...node.data.config,
      invite_assistants: policy.enabled ? policy.assistantIds.map(id => ({ id, name: names.get(id) })) : [],
    } } };
  });
}

// Keep provider preparation and flow persistence in one compensated operation.
// The callback must resolve only after the flow has been persisted successfully.
export async function saveFlowWithPreparedAssistants(nodes, request, options, persist) {
  const ids = [...new Set((nodes || []).filter(node => node.data?.nodeType === "agent_assist")
    .flatMap(node => { const policy = assistantInvitePolicy(node.data.config); return policy.enabled ? policy.assistantIds : []; }))].sort();
  if (!ids.length) return prepareAndPersist(nodes, request, options, persist, null);
  const pool = options?.pool || getAssistantConfigurationPool();
  if (!pool) throw Object.assign(new Error("The configuration database is unavailable."), { status: 503 });
  let db;
  try { db = await pool.connect(); }
  catch { throw Object.assign(new Error("Assistant configuration is busy or unavailable. Try saving again shortly."), { status: 503 }); }
  const locked = [];
  let discardConnection = false;
  try {
    for (const id of ids) {
      const result = await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,814028)) AS acquired", [id]);
      if (!result.rows[0]?.acquired) throw Object.assign(new Error("Another call flow is configuring a selected assistant. Wait for that save to finish and try again."), { status: 409 });
      locked.push(id);
    }
    // Hold the lock through persistence or compensation. Reuse its connection
    // for the flow write without using the application's shared database pool.
    return await prepareAndPersist(nodes, request, options, persist, db);
  } finally {
    for (const id of locked.reverse()) {
      try { await db.query("SELECT pg_advisory_unlock(hashtextextended($1,814028))", [id]); }
      catch { discardConnection = true; }
    }
    db.release(discardConnection);
  }
}

async function prepareAndPersist(nodes, request, options, persist, db) {
  const changes = [];
  let persistenceStarted = false;
  try {
    const prepared = await prepareFlowAssistantInvites(nodes, request, { ...options, changes });
    persistenceStarted = true;
    return await persist(prepared, db);
  } catch (error) {
    // A connection loss can hide an already committed INSERT/UPDATE. Retain the
    // approved provider configuration rather than disconnect a persisted flow.
    if (persistenceStarted && changes.length && isPostgresConnectionFailure(error)) {
      throw Object.assign(new Error("The database connection was lost before the save could be confirmed. The flow may already be saved. The approved Conversation WebSocket settings were retained. Reload the flow to check its state before retrying."), { status: 503 });
    }
    const failed = await restoreAssistantEventChanges(changes, request);
    if (failed.length) throw Object.assign(new Error(`${error.message} Previous Conversation WebSocket settings could not be restored for: ${failed.join(", ")}. Check those assistants before retrying.`), { status: 503 });
    if (changes.length) error.message += " Previous Conversation WebSocket settings were restored.";
    throw error;
  }
}
