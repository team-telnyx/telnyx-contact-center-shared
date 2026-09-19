import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { chatCopilotFromAppSettings,parseChatCopilotSettings } from "@/lib/contact-center/chat-copilot-settings.mjs";
import { chatCopilotCatalog } from "@/lib/contact-center/chat-copilot";
import { notificationSoundsFromAppSettings, parseNotificationSounds } from "@/lib/contact-center/notification-sounds.mjs";
import {
  agentHoldFromAppSettings,
  consultHoldFromAppSettings,
  normalizeAgentHoldSettings,
  normalizeConsultHoldSettings,
} from "@/lib/acd/consult-hold-settings.mjs";
import {
  agentLifecycleFromAppSettings,
  normalizeAgentLifecycleSettings,
} from "@/lib/acd/agent-lifecycle-settings.mjs";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";

async function GET_handler(request, _context, authz) {
  const user = authz.user;
  if(request && new URL(request.url).searchParams.get("catalog")==="copilot")
    return NextResponse.json(await chatCopilotCatalog(),{headers:{"Cache-Control":"no-store"}});
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const result = await pool.query(
    `SELECT cc_settings FROM app_settings WHERE id = 'default' LIMIT 1`,
  );
  return NextResponse.json({
    ok: true,
    consultHold: consultHoldFromAppSettings(result.rows[0]?.cc_settings),
    agentHold: agentHoldFromAppSettings(result.rows[0]?.cc_settings),
    agentLifecycle: agentLifecycleFromAppSettings(result.rows[0]?.cc_settings),
    copilot: chatCopilotFromAppSettings(result.rows[0]?.cc_settings),
    notificationSounds: notificationSoundsFromAppSettings(result.rows[0]?.cc_settings),
  });
}

function validateHoldSettings(raw, label) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `${label} settings are required`;
  }
  if (raw.announcement_enabled !== false) {
    if (!String(raw.announcement_text || "").trim()) {
      return `${label} announcement message is required when announcements are enabled`;
    }
    if (!String(raw.announcement_voice || "").trim()) {
      return `${label} TTS voice is required when announcements are enabled`;
    }
  }
  return null;
}

async function PUT_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const consultError = validateHoldSettings(body?.consultHold, "Consult hold");
  if (consultError) {
    return NextResponse.json({ error: consultError }, { status: 400 });
  }
  const agentError = validateHoldSettings(body?.agentHold, "Agent hold");
  if (agentError) {
    return NextResponse.json({ error: agentError }, { status: 400 });
  }
  if (!body?.agentLifecycle || typeof body.agentLifecycle !== "object" || Array.isArray(body.agentLifecycle)) {
    return NextResponse.json({ error: "Agent lifecycle settings are required" }, { status: 400 });
  }
  const consultHold = normalizeConsultHoldSettings(body.consultHold);
  const agentHold = normalizeAgentHoldSettings(body.agentHold);
  const agentLifecycle = normalizeAgentLifecycleSettings(body.agentLifecycle);
  let copilot;
  try{if(body.copilot!==undefined)copilot=parseChatCopilotSettings(body.copilot);}
  catch(error){return NextResponse.json({error:error.message},{status:400});}
  let notificationSounds;
  try { if (body.notificationSounds !== undefined) notificationSounds = parseNotificationSounds(body.notificationSounds); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
  const updatedBy = user.username || user.email || user.id;
  await pool.query(
    `INSERT INTO app_settings (id, cc_settings, updated_by, updated_at)
     VALUES (
       'default',
       jsonb_build_object('consult_hold', $1::jsonb, 'agent_hold', $2::jsonb, 'agent_lifecycle', $3::jsonb)
         || CASE WHEN $5::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('chat_copilot',$5::jsonb) END
         || CASE WHEN $6::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('notification_sounds',$6::jsonb) END,
       $4,
       now()
     )
     ON CONFLICT (id) DO UPDATE SET
       cc_settings = COALESCE(app_settings.cc_settings, '{}'::jsonb)
         || jsonb_build_object('consult_hold', $1::jsonb, 'agent_hold', $2::jsonb, 'agent_lifecycle', $3::jsonb)
         || CASE WHEN $5::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('chat_copilot',$5::jsonb) END
         || CASE WHEN $6::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('notification_sounds',$6::jsonb) END,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [JSON.stringify(consultHold), JSON.stringify(agentHold), JSON.stringify(agentLifecycle), updatedBy,copilot?JSON.stringify(copilot):null, notificationSounds ? JSON.stringify(notificationSounds) : null],
  );
  return NextResponse.json({ ok: true, consultHold, agentHold, agentLifecycle,...(copilot?{copilot}:{}), ...(notificationSounds ? { notificationSounds } : {}) });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("system_settings:read", GET_handler, { route: "/api/admin/system-settings" });
export const PUT = withPermission("system_settings:update", PUT_handler, { route: "/api/admin/system-settings" });
