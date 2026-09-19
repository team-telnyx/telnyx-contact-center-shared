export function slaSummary(rows) {
  const counts = Object.fromEntries(
    [
      "met",
      "breached",
      "unserved",
      "pending",
      "excluded",
      "not_configured",
      "disabled",
      "unavailable",
    ].map((key) => [key, 0]),
  );
  let atRisk = 0,
    targetWeight = 0,
    configured = 0;
  for (const row of rows) {
    counts[row.state] = (counts[row.state] || 0) + Number(row.total || 0);
    atRisk += Number(row.at_risk || 0);
    if (["met", "breached", "unserved"].includes(row.state)) {
      targetWeight += Number(row.target_sum || 0);
      configured += Number(row.total || 0);
    }
  }
  const denominator = counts.met + counts.breached + counts.unserved;
  return {
    ...counts,
    atRisk,
    denominator,
    rate: denominator ? (100 * counts.met) / denominator : null,
    target: configured ? targetWeight / configured : null,
    unit: "measurements",
    cohort: "started",
  };
}
