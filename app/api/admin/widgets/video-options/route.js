import { videoProfileStatus } from "@/lib/video/ai-profiles.mjs";
import { withWidgetAdmin } from "@/lib/widgets/admin-api";
export const GET = request => withWidgetAdmin(request, async ({ pool }) => {
  const widgetId = new URL(request.url).searchParams.get("widgetId");
  if (widgetId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(widgetId)) return Response.json({error:"Invalid widget ID"},{status:400});
    return Response.json({profiles:await videoProfileStatus(pool,widgetId)},{headers:{"Cache-Control":"no-store"}});
  }
  const queues = (await pool.query(`SELECT q.id,q.name FROM cc_queues q JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel='video' AND c.enabled WHERE q.enabled ORDER BY q.name`)).rows;
  const agents = (await pool.query(`SELECT DISTINCT u.id,u.first_name,u.last_name,u.username,a.queue_id FROM users u JOIN cc_queue_user_assignments a ON a.user_id=u.id AND a.enabled WHERE a.queue_id=ANY($1::text[]) ORDER BY u.first_name,u.last_name`, [queues.map(q => q.id)])).rows;
  const worker = (await pool.query("SELECT COALESCE(sum(capacity-active),0)::int AS available FROM cc_video_ai_workers WHERE heartbeat_at>now()-interval '15 seconds'")).rows[0];
  return Response.json({ queues, agents, workerAvailable: worker.available > 0 }, { headers: { "Cache-Control": "no-store" } });
});
