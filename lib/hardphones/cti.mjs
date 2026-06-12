// Hard Phones CTI — driver registry (Phase 2)
//
// Resolves the right CTI driver for a phone:
//   polycom    → REST API driver (requires reachable phone IP)
//   yealink    → Action URI driver (requires reachable phone IP)
//   audiocodes → Telnyx fallback driver (no native phone CTI)
// Any phone can force the fallback with settings.cti_mode = "telnyx".
import { polycomDriver } from "./drivers/polycom.mjs";
import { yealinkDriver } from "./drivers/yealink.mjs";
import { createTelnyxFallbackDriver } from "./drivers/telnyx-fallback.mjs";

export const CTI_ACTIONS = ["dial", "answer", "hangup", "hold", "resume", "mute", "unmute", "send_dtmf", "status", "reprovision", "reboot"];

export function resolveCtiDriver(phone, { pool = null, baseUrl = "" } = {}) {
  const mode = String(phone?.settings?.cti_mode || "").toLowerCase();
  const vendor = String(phone?.vendor || "").toLowerCase();
  if (mode === "telnyx") return createTelnyxFallbackDriver({ pool, baseUrl });
  if (vendor === "polycom") return polycomDriver;
  if (vendor === "yealink") return yealinkDriver;
  // AudioCodes and anything unknown → server-side control via Telnyx
  return createTelnyxFallbackDriver({ pool, baseUrl });
}

// Execute a named CTI action against a phone through its driver. Returns a
// normalized { ok, reason?, ... } result.
export async function executeCtiAction(phone, action, params = {}, context = {}) {
  const driver = resolveCtiDriver(phone, context);
  switch (String(action || "")) {
    case "dial":
      return driver.dial(phone, params.number);
    case "answer":
      return driver.answer(phone);
    case "hangup":
      return driver.hangup(phone);
    case "hold":
      return driver.hold(phone);
    case "resume":
      return driver.resume(phone);
    case "mute":
      return driver.mute(phone, true);
    case "unmute":
      return driver.mute(phone, false);
    case "send_dtmf":
      return driver.sendDtmf(phone, params.digits);
    case "status":
      return driver.status(phone);
    case "reprovision":
      return driver.reprovision(phone);
    case "reboot":
      return typeof driver.reboot === "function" ? driver.reboot(phone) : { ok: false, reason: "reboot_not_supported" };
    default:
      return { ok: false, reason: "unknown_action" };
  }
}
