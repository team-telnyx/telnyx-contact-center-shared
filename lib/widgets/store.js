import { assertWidgetAssistant } from "./ai-provider.js";
import { ensureWidgetHandoffTool } from "./handoff-tool.js";
import { randomBytes, randomUUID } from "node:crypto";
import { createDefaultWidgetConfig, parseWidgetConfig, normalizeWidgetAssistantConfig, assertPublishableWidgetConfig, widgetQueues } from "./config.js";
import { verifyWidgetAvatar } from "../ai/avatar-extensions.mjs";

const SELECT = `SELECT w.*,d.id AS draft_id,d.version AS draft_version,d.edit_version AS draft_edit_version,d.config AS draft_config,
  p.id AS published_id,p.version AS published_version,p.config AS published_config
  FROM cc_widgets w JOIN cc_widget_revisions d ON d.widget_id=w.id AND d.state='draft'
  LEFT JOIN cc_widget_revisions p ON p.id=w.published_revision_id`;
const fail = (message,status=400) => Object.assign(new Error(message),{status});

function nameFields(value) {
  const name = String(value || "").trim();
  if (!name || name.length>120) throw fail("Widget name must contain 1 to 120 characters");
  return {name,key:name.normalize("NFKC").toLowerCase()};
}
function map(row) {
  if (!row) return null;
  return { id:row.id,publicId:row.public_id,name:row.name,enabled:row.enabled,createdAt:row.created_at,updatedAt:row.updated_at,
    draft:{id:row.draft_id,version:row.draft_version,editVersion:String(row.draft_edit_version),config:parseWidgetConfig(row.draft_config)},
    published:row.published_id?{id:row.published_id,version:row.published_version,config:parseWidgetConfig(row.published_config)}:null };
}
export async function widgetAudit(db, widgetId, actor, action, details={}) {
  await db.query("INSERT INTO cc_widget_audit(widget_id,actor_id,action,details) VALUES($1,$2,$3,$4::jsonb)",[widgetId,actor,action,JSON.stringify(details)]);
}
async function transaction(pool, fn) {
  const tx=await pool.connect();
  try { await tx.query("BEGIN");const result=await fn(tx);await tx.query("COMMIT");return result; }
  catch(error){await tx.query("ROLLBACK");if(error.code==="23505")throw fail("A widget with this name already exists",409);throw error;}
  finally{tx.release();}
}
export async function listWidgets(db) {return (await db.query(`${SELECT} ORDER BY w.updated_at DESC`)).rows.map(map);}
export async function getWidget(db,id) {return map((await db.query(`${SELECT} WHERE w.id=$1`,[id])).rows[0]);}

export async function createWidget(pool,{name,cloneFromId,actor}) {
  const parsed=nameFields(name);
  return transaction(pool,async tx=>{
    const id=randomUUID(),revisionId=randomUUID();
    const source=cloneFromId?await getWidget(tx,cloneFromId):null;
    if(cloneFromId&&!source)throw fail("Source widget not found",404);
    const config=source?structuredClone(source.draft.config):createDefaultWidgetConfig();
    await tx.query(`INSERT INTO cc_widgets(id,public_id,name,normalized_name,enabled,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$6)`,[id,`wgt_${randomBytes(18).toString("base64url")}`,parsed.name,parsed.key,source?.enabled??true,actor]);
    if(source){
      await tx.query(`INSERT INTO cc_widget_preview_assets(widget_id,variant,bytes) SELECT $2,variant,bytes FROM cc_widget_preview_assets WHERE widget_id=$1`,[source.id,id]);
      for(const background of Object.values(config.preview.backgrounds)){
        if(background.backgroundImageUrl.startsWith(`/api/admin/widgets/${source.id}/preview-background?`))
          background.backgroundImageUrl=background.backgroundImageUrl.replace(`/widgets/${source.id}/`,`/widgets/${id}/`);
      }
    }
    await tx.query(`INSERT INTO cc_widget_revisions(id,widget_id,version,state,config,created_by) VALUES($1,$2,1,'draft',$3::jsonb,$4)`,[revisionId,id,JSON.stringify(config),actor]);
    await widgetAudit(tx,id,actor,source?"widget.cloned":"widget.created",source?{sourceId:source.id}:{});
    return getWidget(tx,id);
  });
}

export async function updateWidget(pool,{id,name,enabled,actor}) {
  const parsed=nameFields(name);
  if(typeof enabled!=="boolean")throw fail("Enabled must be boolean");
  return transaction(pool,async tx=>{
    const result=await tx.query(`UPDATE cc_widgets SET name=$2,normalized_name=$3,enabled=$4,updated_by=$5,updated_at=now() WHERE id=$1 RETURNING id`,[id,parsed.name,parsed.key,enabled,actor]);
    if(!result.rowCount)throw fail("Widget not found",404);
    await widgetAudit(tx,id,actor,enabled?"widget.updated":"widget.disabled",{name:parsed.name});
    return getWidget(tx,id);
  });
}

export async function updateWidgetDraft(pool,{id,config,name,enabled,expectedDraftId,expectedEditVersion,actor}) {
  const parsed=normalizeWidgetAssistantConfig(config);
  const metadata=name===undefined?null:nameFields(name);
  if(metadata&&typeof enabled!=="boolean")throw fail("Enabled must be boolean");
  return transaction(pool,async tx=>{
    await tx.query("SELECT id FROM cc_widgets WHERE id=$1 FOR UPDATE",[id]);
    const changed=await tx.query(`UPDATE cc_widget_revisions SET config=$2::jsonb,edit_version=edit_version+1
      WHERE widget_id=$1 AND state='draft' AND id=$3 AND edit_version=$4 RETURNING id`,[id,JSON.stringify(parsed),expectedDraftId||null,expectedEditVersion||null]);
    if(!changed.rowCount)throw fail("Widget draft changed; reload before saving",409);
    if(metadata)await tx.query("UPDATE cc_widgets SET name=$2,normalized_name=$3,enabled=$4 WHERE id=$1",[id,metadata.name,metadata.key,enabled]);
    await tx.query("UPDATE cc_widgets SET updated_by=$2,updated_at=now() WHERE id=$1",[id,actor]);
    await widgetAudit(tx,id,actor,"widget.draft.updated");
    return getWidget(tx,id);
  });
}

async function validateWidgetPublication(db,id) {
  const widget=await getWidget(db,id);if(!widget)throw fail("Widget not found",404);
  const config=assertPublishableWidgetConfig(widget.draft.config);
  const ids=config.channels.messaging.enabled ? widgetQueues(config).map(q=>q.id) : [];
  const eligible=await db.query(`SELECT q.id FROM cc_queues q JOIN cc_queue_channels c ON c.queue_id=q.id
    WHERE q.id=ANY($1::text[]) AND q.enabled=true AND c.channel='chat' AND c.enabled=true`,[ids]);
  if(eligible.rows.length!==ids.length)throw fail("Every widget routing queue must exist and have Chat enabled");
  return {widget,config,conflicts:[],changes:[]};
}

export async function preflightWidget(db,id,{verifyAssistant=assertWidgetAssistant,verifyAvatar=verifyWidgetAvatar}={}) {
  const result=await validateWidgetPublication(db,id);
  const assistantId=result.config.channels.messaging.assistantId||result.config.channels.voice.assistantId;
  if(assistantId)await verifyAssistant(assistantId,{voice:result.config.channels.voice.enabled});
  // The avatar block is only meaningful with voice; a stale or unavailable avatar must not be published.
  if(result.config.channels.voice.enabled&&result.config.channels.voice.avatar?.enabled)await verifyAvatar(result.config.channels.voice.avatar);
  return result;
}

export async function publishWidget(pool,{id,expectedDraftId,expectedEditVersion,actor},
  {provisionHandoff=ensureWidgetHandoffTool,verifyAssistant=assertWidgetAssistant,verifyAvatar=verifyWidgetAvatar}={}) {
  const candidate=await preflightWidget(pool,id,{verifyAssistant,verifyAvatar});
  const assertDraft=widget=>{
    if(widget.draft.id!==expectedDraftId||widget.draft.editVersion!==String(expectedEditVersion))throw fail("Widget draft changed; review before publishing",409);
  };
  assertDraft(candidate.widget);
  // Revalidate after preflight and immediately before each provider mutation.
  // Keep network I/O outside the transaction so editors do not hold row locks.
  const beforeMutation=async()=>assertDraft(await getWidget(pool,id));
  await beforeMutation();
  const handoffTool=await provisionHandoff(pool,{config:candidate.config,beforeMutation});
  return transaction(pool,async tx=>{
    await tx.query("SELECT id FROM cc_widgets WHERE id=$1 FOR UPDATE",[id]);
    const {widget,config}=await validateWidgetPublication(tx,id);
    assertDraft(widget);
    await tx.query("UPDATE cc_widget_revisions SET state='archived' WHERE widget_id=$1 AND state='published'",[id]);
    await tx.query("UPDATE cc_widget_revisions SET state='published',config=$2::jsonb,published_at=now() WHERE id=$1",[widget.draft.id,JSON.stringify(config)]);
    await tx.query("UPDATE cc_widgets SET published_revision_id=$2,updated_by=$3,updated_at=now() WHERE id=$1",[id,widget.draft.id,actor]);
    await tx.query(`INSERT INTO cc_widget_revisions(id,widget_id,version,state,config,created_by)
      VALUES($1,$2,$3,'draft',$4::jsonb,$5)`,[randomUUID(),id,widget.draft.version+1,JSON.stringify(config),actor]);
    await widgetAudit(tx,id,actor,"widget.published",{version:widget.draft.version,handoffToolId:handoffTool?.id});
    return getWidget(tx,id);
  });
}

export async function restoreWidgetRevision(pool,{id,revisionId,expectedDraftId,expectedEditVersion,actor}) {
  return transaction(pool,async tx=>{
    await tx.query("SELECT id FROM cc_widgets WHERE id=$1 FOR UPDATE",[id]);
    const source=(await tx.query("SELECT * FROM cc_widget_revisions WHERE id=$1 AND widget_id=$2 AND state IN ('published','archived')",[revisionId,id])).rows[0];
    if(!source)throw fail("Revision not found",404);
    const result=await tx.query(`UPDATE cc_widget_revisions SET config=$2::jsonb,edit_version=edit_version+1
      WHERE widget_id=$1 AND id=$3 AND edit_version=$4 AND state='draft' RETURNING id`,[id,JSON.stringify(source.config),expectedDraftId,expectedEditVersion]);
    if(!result.rowCount)throw fail("Widget draft changed; reload before restoring",409);
    await widgetAudit(tx,id,actor,"widget.revision.restored",{revisionId,version:source.version});
    return getWidget(tx,id);
  });
}

export async function getPublishedWidget(db,publicId) {
  const row=(await db.query(`SELECT w.*,r.id AS revision_id,r.version,r.config FROM cc_widgets w
    JOIN cc_widget_revisions r ON r.id=w.published_revision_id AND r.state='published'
    WHERE w.public_id=$1 AND w.enabled=true`,[publicId])).rows[0];
  return row?{...row,config:parseWidgetConfig(row.config)}:null;
}
