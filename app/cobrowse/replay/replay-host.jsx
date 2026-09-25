"use client";

import { useEffect, useRef } from "react";
import { Replayer } from "@rrweb/replay";
import "@rrweb/replay/dist/style.css";

function safeEvent(event) {
  const copy = structuredClone(event);
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (value.attributes && typeof value.attributes === "object") {
      for (const key of Object.keys(value.attributes)) {
        const lower = key.toLowerCase();
        if (lower.startsWith("on") || ["src", "srcdoc", "href", "action", "poster", "xlink:href", "nonce", "integrity"].includes(lower)) delete value.attributes[key];
        if (lower === "style") value.attributes[key] = String(value.attributes[key]).replace(/url\([^)]*\)/gi, "url(\"\")");
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && key.toLowerCase().includes("csstext")) value[key] = child.replace(/url\([^)]*\)/gi, "url(\"\")");
      else visit(child);
    }
  }
  visit(copy);
  return copy;
}

export default function ReplayHost() {
  const root = useRef(null);
  const player = useRef(null);
  const meta = useRef(null);
  useEffect(() => {
    const onMessage = (message) => {
      if (message.source !== parent || message.origin !== location.origin) return;
      if (message.data?.type === "cobrowse-hit-test") {
        const { requestId, x, y } = message.data;
        if (!Number.isSafeInteger(requestId) || requestId < 1 || !Number.isInteger(x) || !Number.isInteger(y) ||
          x < 0 || y < 0 || x > 8192 || y > 8192) return;
        let nodeId = -1;
        try {
          const replayFrame = player.current?.iframe;
          const bounds = replayFrame?.getBoundingClientRect();
          const target = bounds && replayFrame.contentDocument?.elementFromPoint(x - bounds.left, y - bounds.top);
          if (target) nodeId = player.current.getMirror().getId(target);
        } catch { /* An unavailable replay target is never controllable. */ }
        parent.postMessage({ type: "cobrowse-hit-test-result", requestId, nodeId }, location.origin);
        return;
      }
      if (message.data?.type !== "cobrowse-events" || !Array.isArray(message.data.events) ||
        message.data.events.length > 100) return;
      for (const raw of message.data.events) {
        const event = safeEvent(raw);
        if (event.type === 4) { meta.current = event; continue; }
        if (event.type === 2) {
          player.current?.destroy();
          root.current?.replaceChildren();
          player.current = new Replayer([], {
            root: root.current, liveMode: true, UNSAFE_replayCanvas: false,
            useVirtualDom: false, triggerFocus: false, mouseTail: false,
            showWarning: false, showDebug: false,
            insertStyleRules: [".cobrowse-cross-origin-placeholder::after{content:'Cross-origin content unavailable';display:block;padding:16px;background:#eee;color:#555}"],
          });
          player.current.startLive(Date.now() + 86_400_000);
          if (player.current.iframe?.getAttribute("sandbox") !== "allow-same-origin") {
            player.current.destroy(); player.current = null; return;
          }
          if (meta.current) player.current.addEvent(meta.current);
        }
        player.current?.addEvent(event);
      }
    };
    window.addEventListener("message", onMessage);
    parent.postMessage({ type: "cobrowse-replay-ready" }, location.origin);
    return () => { window.removeEventListener("message", onMessage); player.current?.destroy(); };
  }, []);
  return <div ref={root} className="h-screen w-screen overflow-hidden bg-white" aria-label="Shared page replay" />;
}
