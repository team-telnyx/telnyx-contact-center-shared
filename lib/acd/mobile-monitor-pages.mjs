/** Opt-in mobile projections. Call only AFTER authorization scope is applied.
 * Response paging bounds device memory/traffic; monitor aggregators still read
 * the full authorized scope to calculate accurate totals.
 */
export function mobilePaging(params) { return params.has("mobilePageSize"); }
const positive = (value, fallback) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
export function pageRows(rows, params, key = "page") {
  const pageSize = Math.min(50, positive(params.get("mobilePageSize"), 25));
  const total = rows.length;
  const page = Math.min(positive(params.get(key), 1), Math.max(1, Math.ceil(total / pageSize)));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total } };
}
const matches = (values, query) => !query || values.filter(Boolean).join(" ").toLocaleLowerCase().includes(query.toLocaleLowerCase().trim());
const waiting = row => ["open", "queued", "offered", "offering", "ringing"].includes(row.state);
const name = row => [row.firstName, row.lastName, row.username].filter(Boolean).join(" ");
const queueName = row => row.queueName || row.queueId;
export function mobileSnapshot(snapshot, params) {
  if (!mobilePaging(params)) return snapshot;
  let agents = [...snapshot.agents.stats];
  let queues = [...snapshot.queues.stats];
  const agentId = params.get("agentId"), queueId = params.get("queueId");
  if (agentId) {
    agents = agents.filter(row => row.userId === agentId);
    const ids = new Set(agents.flatMap(row => row.activeQueueIds || []));
    queues = queues.filter(row => ids.has(row.queueId));
  }
  if (queueId) {
    queues = queues.filter(row => row.queueId === queueId);
    agents = agents.filter(row => row.activeQueueIds?.includes(queueId));
  }
  agents = agents.filter(row => matches([name(row)], params.get("agentSearch")) && (!params.get("agentStatus") || params.get("agentStatus") === "all" || row.status?.toLowerCase() === params.get("agentStatus")));
  queues = queues.filter(row => matches([queueName(row)], params.get("queueSearch")) && (params.get("waitingQueues") !== "true" || (row.realtime?.waitingCalls ?? row.realtime?.currentSize ?? 0) > 0));
  agents.sort((a,b) => Number(!!a.isAvailableForRouting)-Number(!!b.isAvailableForRouting) || name(a).localeCompare(name(b)) || a.userId.localeCompare(b.userId));
  queues.sort((a,b) => (b.realtime?.waitingCalls ?? b.realtime?.currentSize ?? 0)-(a.realtime?.waitingCalls ?? a.realtime?.currentSize ?? 0) || (b.realtime?.activeCalls ?? 0)-(a.realtime?.activeCalls ?? 0) || (b.realtime?.longestWaitSeconds ?? 0)-(a.realtime?.longestWaitSeconds ?? 0) || queueName(a).localeCompare(queueName(b)) || a.queueId.localeCompare(b.queueId));
  const presence = {};
  for (const agent of agents) { const key = (agent.status || "unknown").toLowerCase(); presence[key] = (presence[key] || 0) + 1; }
  const agentPage = pageRows(agents, params, "agentPage"), queuePage = pageRows(queues, params, "queuePage");
  return { ...snapshot, presence, queueWorkload: queuePage.rows, agents: { stats: agentPage.rows, pagination: agentPage.pagination }, queues: { stats: queuePage.rows, pagination: queuePage.pagination } };
}
export function mobileInteractions(result, params) {
  if (!mobilePaging(params)) return result;
  const all = result.interactions || [];
  const parents = all.filter(row => !row.parentInteractionId).filter(row =>
    (!params.get("interactionId") || row.id === params.get("interactionId")) &&
    (!params.get("queueId") || row.queueId === params.get("queueId")) &&
    (!params.get("agentId") || row.agentUserId === params.get("agentId")) &&
    (params.get("waitingOnly") !== "true" || waiting(row)) &&
    matches([row.customerName, row.fromNumber, row.toNumber, row.queueName, row.agentName, row.agentUsername], params.get("search"))
  ).sort((a,b) => Number(waiting(b))-Number(waiting(a)) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.id.localeCompare(b.id));
  const { rows, pagination } = pageRows(parents, params);
  const ids = new Set(rows.map(row => row.workItemId || row.id));
  const legs = all.filter(row => row.parentInteractionId && ids.has(row.parentInteractionId));
  const matchingIds = new Set(parents.map(row => row.workItemId || row.id));
  // Keep child payloads bounded too; disclose omitted legs instead of implying
  // that the displayed children are the complete call topology.
  const displayedLegs = [], omittedLegs = {};
  for (const id of ids) {
    const children = legs.filter(row => row.parentInteractionId === id);
    displayedLegs.push(...children.slice(0,10));
    if (children.length > 10) omittedLegs[id] = children.length - 10;
  }
  return { interactions: [...rows, ...displayedLegs], pagination, omittedLegs, timestamp: result.timestamp,
    totals: { interactions: parents.length, legs: all.filter(row => row.parentInteractionId && matchingIds.has(row.parentInteractionId)).length } };
}

export function mobileDirectory(result, params) {
  if (!mobilePaging(params)) return result;
  const output = { ok: result.ok, patients: [], pagination: {} };
  for (const key of ["users", "customers", "assistants"]) {
    const rows = (result[key] || []).filter(row => matches([
      row.name, row.username, row.first_name, row.last_name, row.display_name,
      row.company_name, row.nick, row.phone, row.mobile, row.voice_number,
      row.telephony_user_name, row.business_phone_1, row.business_phone_2,
      row.home_phone_1, row.home_phone_2, row.id,
    ], params.get("search")));
    const paged = pageRows(rows, params, `${key}Page`);
    output[key] = paged.rows;
    output.pagination[key] = paged.pagination;
  }
  return output;
}

export function mobileReport(report, params) {
  if (!mobilePaging(params)) return report;
  const queues = pageRows(report.queues || [], params);
  return { channels: report.channels, totals: report.totals, sla: report.sla, trend: report.trend,
    queues: queues.rows, pagination: queues.pagination, filters: report.filters };
}
export function mobileThread(thread, params) {
  if (!mobilePaging(params)) return thread;
  // Producer orders messages oldest-first. Keep each page chronological, but
  // page 1 opens at the newest end. Reply context remains global across pages.
  const messages = thread.messages || [];
  const page = pageRows([...messages].reverse(), params);
  const lastCustomer = [...messages].reverse().find(row => row.sender_role === "customer");
  return { ...thread, messages: page.rows.reverse(), pagination: page.pagination, latestCustomerMessageId: lastCustomer?.id || null };
}

export function mobileInbox(interactions, params) {
  const offered = row => ["offered", "offering", "ringing"].includes(row.state);
  const rows = interactions.filter(row => (!params.get("interactionId") || row.id === params.get("interactionId")) && matches([
    row.customer_name, row.from_name, row.customer_address, row.from_number, row.to_number, row.queue_name, row.channel,
  ], params.get("search"))).sort((a,b) => Number(offered(b))-Number(offered(a)) || String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.id.localeCompare(b.id));
  const page = pageRows(rows, params);
  return { ok: true, interactions: page.rows, pagination: page.pagination };
}
