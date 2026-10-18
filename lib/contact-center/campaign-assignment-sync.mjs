// Campaign activation events contain the complete active set, including an empty set.
export function patchCampaignActivations(rows, campaignIds) {
  if (!Array.isArray(campaignIds)) return rows;
  const active = new Set(campaignIds.map(String));
  let changed = false;
  const next = rows.map((row) => {
    const activated = active.has(String(row.id));
    if (row.activated === activated) return row;
    changed = true;
    return { ...row, activated };
  });
  return changed ? next : rows;
}
