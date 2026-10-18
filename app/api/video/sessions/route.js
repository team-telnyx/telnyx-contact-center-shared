import { withPermission } from '@/lib/authz/guard';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { interactionScopeSql } from '@/lib/authz/scope.mjs';
import { videoRecordingStreamPath } from '@/lib/video/lifecycle.mjs';
export const GET = withPermission('recordings:read', async (request, context, authz) => {
  const widgetId = new URL(request.url).searchParams.get('widgetId');
  if (!/^[a-f0-9-]{36}$/i.test(widgetId || '')) return Response.json({error:'A widget ID is required'}, {status:400});
  const pool = getPostgresPool(), values = [widgetId];
  const scope = interactionScopeSql(authz.scope, {queue:"v.conference_config->'routing'->>'queueId'",workItem:'v.work_item_id',channel:"'video'"}, values);
  const sessions = (await pool.query(`SELECT v.id,v.work_item_id,v.state,v.started_at,v.ended_at,v.created_at,v.composition_state,v.composition_error,v.artifacts,c.customer_name,
    a.started_at AS ai_started_at,a.ended_at AS ai_ended_at,a.state AS ai_state,
    (SELECT min(created_at) FROM cc_video_ai_events WHERE video_session_id=v.id AND kind='ai.handoff') AS human_requested_at
    FROM acd_video_sessions v JOIN acd_conversations c ON c.id=v.conversation_id LEFT JOIN cc_video_ai_sessions a ON a.video_session_id=v.id
    WHERE EXISTS(SELECT 1 FROM cc_widget_sessions s WHERE s.conversation_id=v.conversation_id AND s.widget_id=$1)
    ${scope.length?'AND '+scope.join(' AND '):''} ORDER BY v.created_at DESC LIMIT 20`, values)).rows;
  for (const session of sessions) {
    const recorded = session.work_item_id ? (await pool.query("SELECT provider_recording_id,format,provider_metadata FROM acd_recordings WHERE work_item_id=$1 AND provider='telnyx_video' ORDER BY created_at DESC",[session.work_item_id])).rows : [];
    session.recordings = [...recorded.map(r=>({id:r.provider_recording_id,kind:r.provider_metadata.kind,format:r.format})),...(session.artifacts||[]).map(r=>({id:r.providerRecordingId,kind:r.kind,format:r.format}))].map(r=>({...r,url:videoRecordingStreamPath(r.id,r.kind)}));
    delete session.artifacts;
  }
  return Response.json({sessions}, {headers:{'Cache-Control':'no-store'}});
});
