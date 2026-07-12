export const AGENT_HOME = null;
export const SUPERVISOR_HOME = "/supervisor/monitor?section=overview";
export const ADMIN_HOME = "/admin/system/dashboard";

export function resolveHomeDestination(roles) {
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
