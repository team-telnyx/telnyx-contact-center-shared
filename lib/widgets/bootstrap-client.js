"use client";

const REFRESH_TIMEOUT_MS = 10_000;

function parentOrigin() {
  return new URLSearchParams(window.location.search).get("parentOrigin") || "";
}

export function requestFreshWidgetBootstrap(publicId) {
  const expectedOrigin = parentOrigin();
  if (!expectedOrigin || window.parent === window) {
    return Promise.reject(new Error("Widget bootstrap host is unavailable"));
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Widget bootstrap refresh timed out"));
    }, REFRESH_TIMEOUT_MS);
    function finish(callback, value) {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      callback(value);
    }
    function onMessage(event) {
      if (event.source !== window.parent || event.origin !== expectedOrigin) return;
      if (event.data?.type !== "telnyx-widget-bootstrap-response" || event.data.requestId !== requestId) return;
      if (event.data.error || !event.data.widget?.bootstrapToken) {
        finish(reject, new Error(event.data.error || "Widget bootstrap refresh failed"));
        return;
      }
      finish(resolve, event.data.widget);
    }
    window.addEventListener("message", onMessage);
    window.parent.postMessage({
      type: "telnyx-widget-bootstrap-request",
      requestId,
      widgetId: publicId,
    }, expectedOrigin);
  });
}
