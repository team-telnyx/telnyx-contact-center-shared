import { interactionScopeSql } from '../authz/scope.mjs';
import { resolveReportingScope } from './reporting-scope.mjs';

export async function readMobileInteractionDirectory(db, params, restriction) {
  const scope = await resolveReportingScope(db, params, restriction);
  const values = [scope.channels];
  const where = ['w.terminal_at IS NULL', "w.state NOT IN ('completed','abandoned','cancelled','failed')", 'w.channel = ANY($1::text[])'];
  const add = (sql, value) => { values.push(value); where.push(sql.replace('?', '$' + values.length)); };
  const direction = params.get('direction');
  if (direction && direction !== 'all') {
    if (!['inbound','outbound','internal'].includes(direction)) throw Object.assign(new Error('Invalid direction'), {status:400});
    add('w.direction = ?', direction);
  }
  if (params.get('queue')?.trim()) add('q.name ILIKE ?', '%' + params.get('queue').trim().slice(0,100) + '%');
  if (params.get('search')?.trim()) add("concat_ws(' ',w.customer_address,w.cc_address,c.customer_name,w.id::text) ILIKE ?", '%' + params.get('search').trim().slice(0,100) + '%');
  where.push(...interactionScopeSql(restriction, {queue:'w.queue_id', agent:'a.agent_id', channel:'w.channel', workItem:'w.id'}, values));
  const from = `FROM acd_work_items w LEFT JOIN cc_queues q ON q.id=w.queue_id
    LEFT JOIN acd_conversations c ON c.id=w.conversation_id
    LEFT JOIN LATERAL (SELECT agent_id FROM acd_segments WHERE work_item_id=w.id AND kind='agent' ORDER BY seq DESC LIMIT 1) a ON true
    LEFT JOIN users u ON u.id=a.agent_id WHERE ${where.join(' AND ')}`;
  const total = Number((await db.query(`SELECT COUNT(*)::int AS total ${from}`, values)).rows[0].total);
  const pageSize = 25;
  const page = Math.min(Math.max(1, Math.floor(Number(params.get('page')) || 1)), Math.max(1,Math.ceil(total/pageSize)));
  const rows = await db.query(`SELECT w.id,w.channel,w.direction,w.state,w.customer_address,w.cc_address,w.created_at,w.terminal_at,
    q.name AS queue_name,w.queue_id,c.customer_name,a.agent_id,concat_ws(' ',u.first_name,u.last_name) AS agent_name
    ${from} ORDER BY w.created_at DESC,w.id DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values,pageSize,(page-1)*pageSize]);
  return { pagination:{page,pageSize,total}, rows:rows.rows.map(r=>({
    ...r, interaction:{id:r.id,workItemId:r.id,channel:r.channel,direction:r.direction,state:r.state,
      queueId:r.queue_id,queueName:r.queue_name,customerName:r.customer_name,
      fromNumber:r.direction==='outbound'?r.cc_address:r.customer_address,
      toNumber:r.direction==='outbound'?r.customer_address:r.cc_address,
      agentUserId:r.agent_id,agentName:r.agent_name,createdAt:r.created_at,
      capabilities:{conversation:['sms','whatsapp','email','chat'].includes(r.channel),supervision:false}}
  })) };
}
