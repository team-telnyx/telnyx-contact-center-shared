export const AGENT_CAMPAIGN_ACTIVATION_STATUSES = ["running", "paused", "stopped"];

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function agentCampaignStatusBadgeClass(status) {
  const value = String(status || "").toLowerCase();
  if (value === "running") return "border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "paused") return "border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (value === "stopped") return "border-rose-500/45 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-muted-foreground/30 text-muted-foreground";
}

export function normalizeCampaignPriority(campaign = {}) {
  const metadata = parseJson(campaign.metadata, {});
  const numeric = Number(metadata.agent_priority ?? metadata.priority ?? campaign.priority ?? 3);
  if (!Number.isFinite(numeric)) return 3;
  return Math.min(5, Math.max(1, Math.floor(numeric)));
}

export function campaignModeBadgeClass(mode) {
  const value = String(mode || "").toLowerCase();
  if (value === "preview") return "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-200";
  if (value === "progressive") return "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-200";
  return "border-muted-foreground/30 bg-muted/30 text-muted-foreground";
}

export function campaignDistributionWeight(campaign = {}) {
  return normalizeCampaignPriority(campaign);
}

export function campaignServedCount(campaign = {}) {
  const assignmentMetadata = parseJson(campaign.assignment_metadata ?? campaign.assignmentMetadata, {});
  const numeric = Number(assignmentMetadata.served_count ?? campaign.served_count ?? campaign.servedCount ?? 0);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

export function priorityDistributionCursor(campaigns = []) {
  const candidates = (campaigns || []).filter(Boolean);
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => {
    const aWeight = campaignDistributionWeight(a);
    const bWeight = campaignDistributionWeight(b);
    const aRatio = campaignServedCount(a) / aWeight;
    const bRatio = campaignServedCount(b) / bWeight;
    if (aRatio !== bRatio) return aRatio - bRatio;
    if (aWeight !== bWeight) return bWeight - aWeight;
    return String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""));
  })[0];
}
