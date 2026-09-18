export function formatCapacityUtilization(used, budget) {
  if (used == null || budget == null) return "—";
  const usage = Number(used), capacity = Number(budget);
  if (!Number.isFinite(usage) || !Number.isFinite(capacity) || usage < 0 || capacity <= 0) return "—";
  return `${Math.round((usage / capacity) * 100)}% / 100%`;
}
