import { screensPermit, listScreenLeaves } from "./authz/permissions.mjs";

export const AGENT_HOME = null;
export const SUPERVISOR_HOME = "/supervisor/monitor?section=overview";
export const ADMIN_HOME = "/admin/system/dashboard";

const SUPERVISOR_ENTRIES = [
  ["supervisor.monitor", SUPERVISOR_HOME],
  ["supervisor.analytics", "/supervisor/analytics"],
  ["supervisor.quality", "/supervisor/quality"],
  ["supervisor.outbound-dialer", "/supervisor/outbound-dialer"],
  ["supervisor.scheduled-events", "/supervisor/scheduled-events"],
];

/**
 * First screen the user may open, in the order agent → supervisor → admin
 * (RBAC Phase 3). `screens` are the user's screen grants (leaf ids, group
 * wildcards or "*"); without them the legacy role order decides.
 */
export function resolveHomeDestination(roles, screens = null) {
  if (Array.isArray(screens)) {
    if (screensPermit(screens, "agent.desktop", { group: true })) return AGENT_HOME;
    for (const [screen, path] of SUPERVISOR_ENTRIES) {
      if (screensPermit(screens, screen, { group: true })) return path;
    }
    if (screensPermit(screens, "admin.system.dashboard")) return ADMIN_HOME;
    const leaf = listScreenLeaves().find((entry) => entry.id.startsWith("admin.") && entry.path?.startsWith("/") && screensPermit(screens, entry.id));
    if (leaf) return leaf.path;
    const agentConfiguration = listScreenLeaves().find((entry) => entry.id === "agent.configuration");
    if (agentConfiguration?.path && screensPermit(screens, agentConfiguration.id)) return agentConfiguration.path;
    return AGENT_HOME;
  }
  const normalized = (Array.isArray(roles) ? roles : roles ? [roles] : [])
    .map((role) => String(role || "").toLowerCase().trim())
    .filter(Boolean);

  if (normalized.includes("agent")) return AGENT_HOME;
  if (normalized.includes("supervisor")) return SUPERVISOR_HOME;
  if (normalized.includes("admin") || normalized.includes("owner")) {
    return ADMIN_HOME;
  }

  return AGENT_HOME;
}
