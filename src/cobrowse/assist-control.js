const SENSITIVE = /(?:pass(?:word)?|secret|token|otp|one.?time|social.?security|ssn|tax.?id|iban|bank|account.?number|card|credit|cvv|cvc|pin)/i;
const BLOCKED_INPUT_TYPES = new Set(["password", "hidden", "file", "submit", "reset", "button", "checkbox", "radio"]);
const ALLOWED_INPUT_TYPES = new Set(["text", "search", "email", "tel", "url", "number"]);

function privateTarget(target, privacy) {
  const selectors = ["[data-cobrowse-block]", "[data-cobrowse-mask]", "[data-sensitive]",
    "[id^='telnyx-widget-']", "[autocomplete*='cc-']", ...(privacy.blockSelectors || []), ...(privacy.maskSelectors || [])];
  try { return selectors.some((selector) => target.closest(selector)); }
  catch { return true; }
}

function writableField(target, privacy) {
  if (!target?.hasAttribute?.("data-cobrowse-control") || privateTarget(target, privacy) ||
    target.disabled || target.readOnly || target.closest("[inert]") || target.closest("[aria-hidden='true']")) return false;
  if (target instanceof HTMLTextAreaElement) return !SENSITIVE.test(`${target.name} ${target.id} ${target.autocomplete}`);
  if (!(target instanceof HTMLInputElement) || BLOCKED_INPUT_TYPES.has(target.type) || !ALLOWED_INPUT_TYPES.has(target.type)) return false;
  return !SENSITIVE.test(`${target.name} ${target.id} ${target.autocomplete}`);
}

export function assistFieldAt(target, privacy) {
  return writableField(target, privacy) ? target : null;
}

export function fillAssistField(target, value, privacy) {
  if (document.visibilityState !== "visible" || !target?.isConnected ||
    typeof value !== "string" || value.length > 500 || !writableField(target, privacy)) return false;
  const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) return false;
  target.focus();
  setter.call(target, target.maxLength > -1 ? value.slice(0, target.maxLength) : value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export function applyAssistCommand(command, target, privacy) {
  if (document.visibilityState !== "visible") return false;
  if (command.action === "scroll") {
    if (!Number.isInteger(command.deltaX) || !Number.isInteger(command.deltaY) ||
      Math.abs(command.deltaX) > 1000 || Math.abs(command.deltaY) > 1000) return false;
    window.scrollBy({ left: command.deltaX, top: command.deltaY, behavior: "instant" });
    return true;
  }
  if (!(target instanceof Element) || !target.isConnected || target.ownerDocument !== document ||
    privateTarget(target, privacy)) return false;
  if (command.action !== "click") return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (!writableField(target, privacy)) return false;
    target.focus();
    return true;
  }
  const link = target.closest("a[href]");
  if (link) {
    if (!link.hasAttribute("data-cobrowse-control") || link.hasAttribute("download") ||
      (link.target && link.target !== "_self")) return false;
    try { if (new URL(link.href, location.href).origin !== location.origin) return false; }
    catch { return false; }
    link.click();
    return true;
  }
  const button = target.closest("button");
  if (!button || button.disabled || button.closest("form") || button.type !== "button" ||
    !button.hasAttribute("data-cobrowse-control")) return false;
  button.click();
  return true;
}
