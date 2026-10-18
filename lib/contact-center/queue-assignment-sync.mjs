// Preserve row identity for unchanged switches and normalize IDs from all clients.
export function patchQueueActivations(rows, queueIds, activated, { replace = false } = {}) {
  if (!Array.isArray(queueIds) || (!replace && typeof activated !== "boolean")) return rows;
  const ids = new Set(queueIds.map(String));
  let changed = false;
  const next = rows.map((row) => {
    if (!replace && !ids.has(String(row.id))) return row;
    const isActivated = replace ? ids.has(String(row.id)) : activated;
    if (row.isActivated === isActivated) return row;
    changed = true;
    return { ...row, isActivated };
  });
  return changed ? next : rows;
}

export function patchAgentQueueCount(agent, queueIds, activated) {
  if (!Array.isArray(agent.activeQueueIds)) return agent;
  const active = new Set(agent.activeQueueIds.map(String));
  for (const id of queueIds.map(String)) {
    if (activated) active.add(id);
    else active.delete(id);
  }
  return { ...agent, activeQueueIds: [...active], activeQueues: active.size };
}
