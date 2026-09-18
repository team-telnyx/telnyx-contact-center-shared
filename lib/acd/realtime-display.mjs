// Freeze completed phases while the interaction remains visible in wrap-up.
export function realtimeDurations(row, now = Date.now()) {
  const seconds = (start, end) => start ? Math.max(0, Math.floor(((end ? Date.parse(end) : Number(now)) - Date.parse(start)) / 1000)) : null;
  return {
    elapsed: seconds(row.createdAt, row.completedAt),
    wait: seconds(row.enqueuedAt, row.waitEndedAt || row.answeredAt || row.completedAt) ?? row.waitSeconds,
    handling: seconds(row.answeredAt, row.handlingEndedAt || row.completedAt) ?? row.handlingSeconds,
  };
}
