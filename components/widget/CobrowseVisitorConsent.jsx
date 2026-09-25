"use client";

import { useEffect, useState } from "react";

function parentOrigin() {
  return new URLSearchParams(window.location.search).get("parentOrigin") || "*";
}

export default function CobrowseVisitorConsent({ config, sessionToken, tabKey, preview = false }) {
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (preview || !config?.cobrowse?.enabled || !config.cobrowse.entryPoints.inSession || !sessionToken || !tabKey) return undefined;
    let cancelled = false;
    let timer;
    async function poll() {
      try {
        const response = await fetch("/api/widget-sessions/cobrowse-state", {
          headers: { Authorization: `Bearer ${sessionToken}`, "X-Cobrowse-Tab": tabKey }, cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (!cancelled && response.ok) setSession(data.session?.state === "pending_consent" ? data.session : null);
        if (!cancelled && [401, 403].includes(response.status)) setSession(null);
      } catch { /* Keep the last pending decision visible during a transient error. */ }
      finally { if (!cancelled) timer = window.setTimeout(poll, 2000); }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [config?.cobrowse?.enabled, config?.cobrowse?.entryPoints.inSession, preview, sessionToken, tabKey]);

  if (!session || session.state !== "pending_consent") return null;

  async function decide(accepted) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const targetOrigin = parentOrigin();
      if (targetOrigin === "*") throw new Error("Embedding page origin is unavailable");
      const response = await fetch("/api/widget-sessions/cobrowse/consent", {
        method: "POST", headers: { Authorization: `Bearer ${sessionToken}`, "X-Cobrowse-Tab": tabKey, "Content-Type": "application/json" },
        body: JSON.stringify({ accepted }), cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not save your decision");
      if (accepted && result.browserCredential) window.parent.postMessage({
        type: "telnyx-cobrowse-start", sessionId: result.session.id,
        browserCredential: result.browserCredential,
      }, targetOrigin);
      setSession(null);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  return <div className="absolute inset-0 z-[60] grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Page sharing consent">
    <div className="w-full max-w-sm rounded-xl bg-white p-5 text-slate-900 shadow-2xl">
      <h2 className="text-lg font-semibold">Share this page?</h2>
      <p className="mt-2 text-sm">{session.agentName || "Your support agent"} would like to view this browser tab. This decision does not allow control; that requires a separate request and approval.</p>
      <p className="mt-3 text-sm">{session.consent?.text || config.cobrowse.consent.text}</p>
      <p className="mt-2 text-xs text-slate-600">Only this tab is shared. Recording is off. You can stop at any time using the page banner.</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => void decide(false)} className="rounded-lg border px-3 py-2 text-sm">Decline</button>
        <button type="button" disabled={busy} onClick={() => void decide(true)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">{busy ? "Please wait…" : "Share this page"}</button>
      </div>
    </div>
  </div>;
}
