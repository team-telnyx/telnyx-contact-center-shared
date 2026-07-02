export const ROLE_ALL = "all";
export const ROLE_WEB = "web";
export const ROLE_WORKER = "worker";
export const ROLE_STREAMING = "streaming";

const VALID_ROLES = new Set([ROLE_ALL, ROLE_WEB, ROLE_WORKER, ROLE_STREAMING]);

export function getProcessRole(value = process.env.PROCESS_ROLE || "all") {
  const role = String(value || ROLE_ALL).trim().toLowerCase();
  return VALID_ROLES.has(role) ? role : ROLE_ALL;
}

export function allowsWebRole(role = getProcessRole()) {
  const normalized = getProcessRole(role);
  return normalized === ROLE_ALL || normalized === ROLE_WEB;
}

export function allowsWorkerRole(role = getProcessRole()) {
  const normalized = getProcessRole(role);
  return normalized === ROLE_ALL || normalized === ROLE_WORKER;
}

export function allowsStreamingRole(role = getProcessRole()) {
  const normalized = getProcessRole(role);
  return normalized === ROLE_ALL || normalized === ROLE_STREAMING;
}

export function allowsMaintenanceRole(role = getProcessRole()) {
  const normalized = getProcessRole(role);
  return normalized === ROLE_ALL || normalized === ROLE_WEB || normalized === ROLE_WORKER;
}
