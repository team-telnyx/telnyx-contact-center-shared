/**
 * Page authorisation (Phase 3 of the internal documentation).
 *
 * Pure decision shared by the proxy (server) and <ScreenGuard> (client): a
 * portal path resolves to a catalogue screen and the caller's screen grants
 * decide. Paths outside the catalogue (profile, help, sign-in) are not gated;
 * portal paths the catalogue does not know are refused (fail closed).
 */
import { resolveScreenForPath, screensPermit, screenLabel } from "./permissions.mjs";

/**
 * @param {{ pathname: string, search?: string, screens: string[] | null }} input
 *        `screens` — leaf ids, group wildcards or "*"; null means unknown (refuse gated paths)
 * @returns {{ allowed: boolean, gated: boolean, screen: string|null, group: boolean, label: string|null, reason: string }}
 */
export function decidePageAccess({ pathname, search = "", screens }) {
  const resolved = resolveScreenForPath(pathname, search);
  if (!resolved) return { allowed: true, gated: false, screen: null, group: false, label: null, reason: "not_gated" };
  if (resolved.unknown || !resolved.screen) {
    return { allowed: false, gated: true, screen: null, group: false, label: null, reason: "unknown_screen" };
  }
  if (!Array.isArray(screens)) {
    return { allowed: false, gated: true, screen: resolved.screen, group: Boolean(resolved.group), label: screenLabel(resolved.screen), reason: "screens_unavailable" };
  }
  const allowed = screensPermit(screens, resolved.screen, { group: Boolean(resolved.group) });
  return {
    allowed,
    gated: true,
    screen: resolved.screen,
    group: Boolean(resolved.group),
    label: screenLabel(resolved.screen),
    reason: allowed ? "granted" : "not_granted",
  };
}

/** Where the proxy sends a refused request: the home page announces the missing screen. */
export function deniedRedirectPath(screen) {
  return `/?denied=${encodeURIComponent(screen || "unknown")}`;
}
