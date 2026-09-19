// Core owns timeout completion. The UI displays its persisted absolute deadline;
// it must never manufacture a fresh 30-second deadline on reload.
export function wrapupClock(data, now = Date.now()) {
  return data.acdOwned
    ? { core: true, deadline: Date.parse(data.wrapupDeadlineAt), pending: data.wrapupPending !== false }
    : { core: false, deadline: now + 30_000, pending: true };
}
export function wrapupSeconds(clock, now = Date.now()) {
  return Number.isFinite(clock?.deadline) ? Math.max(0, Math.ceil((clock.deadline - now) / 1000)) : null;
}
