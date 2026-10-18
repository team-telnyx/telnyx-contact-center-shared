import { queueScopeSql } from "../authz/scope.mjs";
import { mobilePaging, pageRows } from "./mobile-monitor-pages.mjs";

export async function readTransferQueues(db, params, scope) {
  const args = [];
  const restriction = queueScopeSql(scope, "q.id", args).map(part => ` AND ${part}`).join("");
  const rows = (await db.query(`SELECT q.id,q.name,q.display_name,q.routing_strategy
    FROM cc_queues q WHERE q.enabled=true AND q.active=true${restriction}
    ORDER BY q.priority DESC,q.name,q.id`, args)).rows;
  if (!mobilePaging(params)) return { queues: rows };
  const search = (params.get("search") || "").trim().toLocaleLowerCase();
  const page = pageRows(rows.filter(q => [q.name,q.display_name].filter(Boolean).join(" ").toLocaleLowerCase().includes(search)), params);
  // Aggregate only the displayed destinations; never send an unbounded workload
  // to a phone. These are voice transfer statistics, not all-channel totals.
  const stats = page.rows.length ? (await db.query(`SELECT w.queue_id,
    COUNT(*) FILTER (WHERE w.state IN ('queued','offered'))::int AS waiting,
    COUNT(*) FILTER (WHERE w.state='active')::int AS active,
    MAX(EXTRACT(EPOCH FROM now()-COALESCE(s.started_at,w.enqueued_at,w.created_at)))
      FILTER (WHERE w.state IN ('queued','offered'))::float AS longest_wait,
    AVG(EXTRACT(EPOCH FROM now()-COALESCE(s.started_at,w.enqueued_at,w.created_at)))
      FILTER (WHERE w.state IN ('queued','offered'))::float AS average_wait
    FROM acd_work_items w LEFT JOIN LATERAL (SELECT started_at FROM acd_segments
      WHERE work_item_id=w.id AND kind='queue_wait' AND ended_at IS NULL ORDER BY seq DESC LIMIT 1) s ON true
    WHERE w.queue_id=ANY($1::text[]) AND w.channel='voice' AND w.terminal_at IS NULL GROUP BY w.queue_id`,
    [page.rows.map(q => q.id)])).rows : [];
  return { queues: page.rows.map(q => {
    const stat = stats.find(s => s.queue_id === q.id);
    return { ...q, statistics: { waiting: stat?.waiting ?? 0, active: stat?.active ?? 0,
      longestWait: Math.max(0, stat?.longest_wait ?? 0), averageWait: Math.max(0, stat?.average_wait ?? 0) } };
  }), pagination: page.pagination };
}
