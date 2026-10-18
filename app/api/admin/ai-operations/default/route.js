import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { withPermission } from '@/lib/authz/guard';
import { AI_OPERATIONS, readDefaultModel } from '@/lib/ai-operations/catalog.mjs';
import { aiOperationsPayload, defaultModelRevision, COPILOT_CHANNELS } from '@/lib/ai-operations/settings-payload.mjs';

/**
 * Admin → AI Copilot: platform default model.
 *
 * PUT  { model, revision }  Save the platform default model ("" = use
 *                           TELNYX_AI_DEFAULT_MODEL from the environment;
 *                           refused when that variable is not set).
 * POST { action: "apply-to-all", revision }
 *                           Refused when the default changed since the admin
 *                           confirmed it, or when there is no default at all.
 *                           Make every AI Copilot operation and every reply
 *                           suggestion channel inherit the platform default:
 *                           their own model choices are cleared. Business
 *                           instructions, tokens and knowledge buckets are kept.
 *
 * Settings live in app_settings.cc_settings (ai_default_model, ai_operations,
 * <channel>_copilot). Both actions lock the settings row.
 */
export const dynamic = 'force-dynamic';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const putSchema = z.object({ model: z.string().trim().max(200), revision: z.string().length(64) }).strict();
const postSchema = z.object({ action: z.literal('apply-to-all'), revision: z.string().length(64) }).strict();

async function withSettings(authz, mutate) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("INSERT INTO app_settings(id,cc_settings) VALUES('default','{}'::jsonb) ON CONFLICT(id) DO NOTHING");
    const current = (await tx.query("SELECT cc_settings FROM app_settings WHERE id='default' FOR UPDATE")).rows[0]?.cc_settings || {};
    const outcome = mutate(current);
    if (outcome.error) { await tx.query('ROLLBACK'); return NextResponse.json({ error: outcome.error }, { status: outcome.status }); }
    await tx.query("UPDATE app_settings SET cc_settings=$1::jsonb,updated_by=$2,updated_at=now() WHERE id='default'", [JSON.stringify(outcome.next), authz.user.username || authz.user.email || authz.user.id]);
    await tx.query('COMMIT');
    return NextResponse.json({ ...aiOperationsPayload(outcome.next, true), ...(outcome.summary ? { applied: outcome.summary } : {}) });
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}

async function PUT_handler(request, _context, authz) {
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (parsed.data.model && !MODEL_ID.test(parsed.data.model))) {
    return NextResponse.json({ error: 'Choose a model from the Telnyx model list.' }, { status: 400 });
  }
  const { model, revision } = parsed.data;
  return withSettings(authz, (current) => {
    if (defaultModelRevision(current) !== revision) return { error: 'The default model changed in another session. Reload before saving.', status: 409 };
    // Removing the saved default falls back to TELNYX_AI_DEFAULT_MODEL. Without
    // it every operation that inherits the default would stop working.
    if (!model && !readDefaultModel({}, process.env).model) return { error: 'TELNYX_AI_DEFAULT_MODEL is not set, so removing the saved default would leave AI operations without a model. Choose another model instead.', status: 409 };
    const next = { ...current };
    if (model) next.ai_default_model = model; else delete next.ai_default_model;
    return { next };
  });
}

async function POST_handler(request, _context, authz) {
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
  return withSettings(authz, (current) => {
    // Checked under the row lock: the default the admin confirmed must still be
    // current, and there must be one, or clearing every override would leave
    // all AI operations without a model.
    if (defaultModelRevision(current) !== parsed.data.revision) return { error: 'The default model changed in another session. Reload before applying it.', status: 409 };
    if (!readDefaultModel(current, process.env).model) return { error: 'There is no default model to apply. Save one first.', status: 409 };
    const operations = { ...(current.ai_operations || {}) };
    let cleared = 0;
    for (const { id } of AI_OPERATIONS) {
      const config = operations[id];
      if (config?.model) cleared += 1;
      operations[id] = { model: '', instructions: typeof config?.instructions === 'string' ? config.instructions : '' };
    }
    const next = { ...current, ai_operations: operations };
    let channels = 0;
    for (const channel of COPILOT_CHANNELS) {
      const key = `${channel}_copilot`;
      if (next[key] && typeof next[key] === 'object') {
        if (next[key].model) channels += 1;
        next[key] = { ...next[key], model: '' };
      }
    }
    return { next, summary: { operations: AI_OPERATIONS.length, clearedOperationModels: cleared, clearedChannelModels: channels } };
  });
}

export const PUT = withPermission('system_settings:update', PUT_handler, { route: '/api/admin/ai-operations/default' });
export const POST = withPermission('system_settings:update', POST_handler, { route: '/api/admin/ai-operations/default' });
