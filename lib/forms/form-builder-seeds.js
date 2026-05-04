import { getFormTemplates, getFormTemplateMediaAssets, getFormDataActionFlows } from "./form-templates.js";

export async function seedFormTemplateMediaAssets(client) {
  const assets = getFormTemplateMediaAssets();
  for (const asset of assets) {
    await client.query(
      `INSERT INTO form_media_assets (filename, url, title, display_name, content_type, size_bytes, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (url) DO UPDATE SET
         filename = EXCLUDED.filename,
         title = EXCLUDED.title,
         display_name = EXCLUDED.display_name,
         content_type = EXCLUDED.content_type,
         size_bytes = EXCLUDED.size_bytes,
         metadata = form_media_assets.metadata || EXCLUDED.metadata,
         updated_at = NOW()`,
      [asset.filename, asset.url, asset.title, asset.display_name, asset.content_type, asset.size_bytes || null, JSON.stringify(asset.metadata || {})]
    );
  }
  return { upserted: assets.length };
}

export async function seedFormTemplates(client, { reset = false } = {}) {
  const templates = getFormTemplates();
  let deleted = 0;
  if (reset) {
    const result = await client.query("DELETE FROM form_templates");
    deleted = result.rowCount || 0;
  }
  for (const [index, tpl] of templates.entries()) {
    await client.query(
      `INSERT INTO form_templates (slug, name, description, category, schema, layout, theme, bindings, actions, queue_names, auto_open, active, sort_order, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,NOW())
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         schema = EXCLUDED.schema,
         layout = EXCLUDED.layout,
         theme = EXCLUDED.theme,
         bindings = EXCLUDED.bindings,
         actions = EXCLUDED.actions,
         queue_names = EXCLUDED.queue_names,
         auto_open = EXCLUDED.auto_open,
         active = true,
         sort_order = EXCLUDED.sort_order,
         updated_at = NOW()`,
      [tpl.slug, tpl.name, tpl.description, tpl.category, JSON.stringify(tpl.schema), JSON.stringify(tpl.layout), JSON.stringify(tpl.theme), JSON.stringify(tpl.bindings || {}), JSON.stringify(tpl.actions || []), tpl.queue_names || [], Boolean(tpl.auto_open), index]
    );
  }
  return { deleted, upserted: templates.length };
}

export async function seedFormDataActionFlows(client) {
  const flows = getFormDataActionFlows();
  for (const flow of flows) {
    await client.query(
      `INSERT INTO voice_flows (id, username, name, description, telnyx_voice_app_id, webhook_url, nodes, edges, variables, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         nodes = EXCLUDED.nodes,
         edges = EXCLUDED.edges,
         variables = EXCLUDED.variables,
         metadata = voice_flows.metadata || EXCLUDED.metadata,
         updated_at = NOW()`,
      [flow.id, flow.username || "system", flow.name, flow.description, flow.telnyx_voice_app_id || null, flow.webhook_url || null, JSON.stringify(flow.nodes || []), JSON.stringify(flow.edges || []), JSON.stringify(flow.variables || {}), JSON.stringify({ ...(flow.metadata || {}), formBuilderSeed: true })]
    );
  }
  return { upserted: flows.length };
}

export async function seedFormBuilderSamples(client, options = {}) {
  const media = await seedFormTemplateMediaAssets(client);
  const templates = await seedFormTemplates(client, options);
  const flows = await seedFormDataActionFlows(client);
  return { media, templates, flows };
}
