import { widgetQueues, parseWidgetConfig } from "./config.js";
import { evaluateWidgetDecisions } from "./decisions.js";
import { widgetHandoffToken } from "./session-tokens.js";

export async function eligibleWidgetHandoffQueues(db, session) {
  const pinned = evaluateWidgetDecisions(session.config, session.context).config;
  const current = evaluateWidgetDecisions(parseWidgetConfig(session.current_config), session.context).config;
  const allowed = widgetQueues(pinned).map(q => q.id), currentAllowed = widgetQueues(current).map(q => q.id);
  return (await db.query(`SELECT q.id,q.name FROM cc_queues q JOIN cc_queue_channels c ON c.queue_id=q.id
    WHERE q.enabled=true AND c.channel='chat' AND c.enabled=true
      AND (cardinality($1::text[])=0 OR q.id=ANY($1))
      AND (cardinality($2::text[])=0 OR q.id=ANY($2)) ORDER BY q.name,q.id`, [allowed,currentAllowed])).rows;
}

export async function widgetHandoffContext(db, session) {
  const integration = (await db.query("SELECT tool_name FROM cc_widget_handoff_integration WHERE singleton=true AND tool_id IS NOT NULL")).rows[0];
  if (!integration) return null;
  const queues = await eligibleWidgetHandoffQueues(db, session);
  const preferred = session.context?.["routing.queue"] || session.context?.routing_queue
    || evaluateWidgetDecisions(session.config,session.context).config.channels.messaging.routing.queueId;
  const defaultQueue = queues.find(q => q.id === preferred || q.name === preferred) || (queues.length === 1 ? queues[0] : null);
  return { toolName:integration.tool_name, token:widgetHandoffToken(session.id), queues, defaultQueue:defaultQueue?.name || null };
}
