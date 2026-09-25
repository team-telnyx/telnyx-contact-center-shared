import { campaignScopeSql, channelScopeSql } from '../authz/scope.mjs';
import { DASHBOARD_SUMMARY_SQL } from './dashboard-summary.mjs';
import { campaignControlState } from './history-view-model.js';
import { campaignContactProgress } from './progress-view-model.js';
import { buildOutboundLiveCallsPayload, OUTBOUND_LIVE_CALLS_SQL } from './live-calls.js';

export async function readMobileDialerPage(db, params, scope) {
  const live = params.get('view') === 'live';
  const values = [];
  const where = dialerScopeSql(scope, values);
  const add = (sql,value) => { values.push(value); where.push(sql.replace('?', '$'+values.length)); };
  if (params.get('search')?.trim()) add('c.name ILIKE ?', '%'+params.get('search').trim().slice(0,100)+'%');
  if (!live) {
    where.push("c.status NOT IN ('draft','design','archived')");
    if (params.get('status') && params.get('status')!=='all') add('c.status = ?', params.get('status'));
  }
  const condition = where.length ? where.join(' AND ') : 'TRUE';
  const source = live ? '(' + OUTBOUND_LIVE_CALLS_SQL.replace(/ORDER BY[\s\S]*$/, '').replace('WHERE (','WHERE '+condition+' AND (') + ')' : null;
  const from = live ? source+' c' : 'outbound_campaigns c WHERE '+condition;
  if (params.get('view') === 'dashboard') return readDashboard(db, from, values);
  const total = Number((await db.query('SELECT COUNT(*)::int AS total FROM '+from,values)).rows[0].total);
  const pageSize=25;
  const page=Math.min(Math.max(1,Math.floor(Number(params.get('page'))||1)),Math.max(1,Math.ceil(total/pageSize)));
  const order = live ? "CASE WHEN c.status IN ('claimed','dialing','answered','running') THEN 0 ELSE 1 END,c.updated_at DESC,c.id" : 'c.name,c.id';
  const result=await db.query('SELECT c.* FROM '+from+' ORDER BY '+order+' LIMIT $'+(values.length+1)+' OFFSET $'+(values.length+2),[...values,pageSize,(page-1)*pageSize]);
  if(live) {
    const calls=buildOutboundLiveCallsPayload(result.rows).calls;
    const ids=calls.map(c=>c.id);
    const linked=ids.length?(await db.query(`SELECT id,outbound_attempt_id,channel,state,created_at,customer_address,cc_address
      FROM acd_work_items WHERE outbound_attempt_id=ANY($1::text[]) AND terminal_at IS NULL`,[ids])).rows:[];
    return {pagination:{page,pageSize,total},rows:calls.map(call=>{
      const work=linked.find(w=>w.outbound_attempt_id===call.id);
      return {...call,interaction:work?{id:work.id,workItemId:work.id,channel:work.channel,direction:'outbound',state:work.state,
        customerName:null,fromNumber:work.cc_address,toNumber:work.customer_address,createdAt:work.created_at}:null};
    })};
  }
  const ids=result.rows.map(r=>r.id);
  const summaries=ids.length?(await db.query(DASHBOARD_SUMMARY_SQL,[ids])).rows:[];
  const lists=ids.length?(await db.query('SELECT id,record_count,valid_phone_count FROM outbound_contact_lists WHERE id IN (SELECT contact_list_id FROM outbound_campaigns WHERE id=ANY($1::uuid[]))',[ids])).rows:[];
  const rows=result.rows.map(c=>{
    const summary=summaries.find(s=>s.campaign_id===c.id)||{};
    const progress=campaignContactProgress(c,lists,{summary});
    return {id:c.id,name:c.name,channel:c.channel,mode:c.mode,status:c.status,
      summary,progress,controls:campaignControlState(c,false,{progress,live:{active:summary.active_now||0,ringing:summary.dialing_now||0}})};
  });
  const totals=(await db.query("SELECT COUNT(*)::int AS campaigns,COUNT(*) FILTER(WHERE c.status='running')::int AS running,COUNT(*) FILTER(WHERE c.status='paused')::int AS paused FROM "+from,values)).rows[0];
  return {pagination:{page,pageSize,total},rows,totals};
}

// Aggregate in PostgreSQL across the full authorized campaign set. No page-sized
// client-side totals and no unbounded campaign/attempt payload is sent to mobile.
async function readDashboard(db, from, values) {
  const summarySql = DASHBOARD_SUMMARY_SQL.replace(
    'l.campaign_id = ANY($1::uuid[])', 'l.campaign_id IN (SELECT id FROM scoped_campaigns)');
  const result = await db.query(`WITH scoped_campaigns AS (SELECT c.* FROM ${from}),
    summaries AS (${summarySql}), campaign_totals AS (
      SELECT COUNT(*)::int AS campaigns,
        COUNT(*) FILTER (WHERE c.status='running')::int AS running,
        COUNT(*) FILTER (WHERE c.status='paused')::int AS paused,
        COALESCE(SUM(CASE
          WHEN COALESCE(c.metadata->>'total_records',c.metadata->>'totalRecords','') ~ '^[0-9]+$'
          THEN COALESCE(c.metadata->>'total_records',c.metadata->>'totalRecords')::numeric
          ELSE COALESCE(l.record_count,l.valid_phone_count,0) END),0) AS contacts
      FROM scoped_campaigns c LEFT JOIN outbound_contact_lists l ON l.id=c.contact_list_id
    ), traffic AS (
      SELECT COALESCE(SUM(s.active_now) FILTER (WHERE c.channel='voice'),0) AS active_calls,
        COALESCE(SUM(s.dialing_now) FILTER (WHERE c.channel='voice'),0) AS ringing_calls,
        COALESCE(SUM(s.attempts_last_15m),0) AS attempts_last_15m,
        COALESCE(SUM(s.messages_queued+s.messages_in_flight) FILTER (WHERE c.channel IN ('sms','whatsapp','email')),0) AS messages_queued
      FROM summaries s JOIN scoped_campaigns c ON c.id=s.campaign_id
    ) SELECT * FROM campaign_totals CROSS JOIN traffic`, values);
  return {rows:[], pagination:{page:1,pageSize:25,total:0}, totals:result.rows[0]};
}

// A role grants a campaign/channel pair. OR complete grants, never their
// projections: flattening the axes creates cross-role permissions.
function dialerScopeSql(scope, values) {
  if (!scope?.restricted) return [];
  if (scope.clauses) {
    const alternatives = scope.clauses.map(clause => {
      const parts = dialerScopeSql(clause, values);
      return parts.length ? `(${parts.join(' AND ')})` : 'TRUE';
    });
    return [alternatives.length ? `(${alternatives.join(' OR ')})` : 'FALSE'];
  }
  return [...campaignScopeSql(scope, 'c.id::text', values), ...channelScopeSql(scope, 'c.channel', values)];
}
