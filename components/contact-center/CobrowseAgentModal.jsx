"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

const liveStates = new Set(["pending_consent", "connecting", "active", "reconnecting"]);

export default function CobrowseAgentModal({ interaction, onClose }) {
  const [state, setState] = useState({ status: "loading", session: null, entryPoint: null, error: "" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const workItemId = interaction.id;

  useEffect(() => {
    let cancelled = false;
    let timer;
    async function poll() {
      try {
        const response = await fetch(`/api/contact-center/cobrowse/${workItemId}`, { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!cancelled) setState((current) => response.ok
          ? { status: "ready", session: data.session, entryPoint: data.entryPoint,
              error: current.session?.id === data.session?.id ? current.error : "" }
          : { status: "error", session: null, entryPoint: null, error: data.error || "Could not load co-browsing" });
      } catch {
        if (!cancelled) setState((current) => current.status === "loading"
          ? { ...current, status: "error", error: "Could not load co-browsing" } : current);
      } finally { if (!cancelled) timer = setTimeout(poll, 2000); }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workItemId]);

  function openDetail() {
    window.dispatchEvent(new CustomEvent("contact-center:cobrowse-changed", { detail: { workItemId, open: true } }));
    onClose();
  }

  async function act(action) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/contact-center/cobrowse/${workItemId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "claim" ? { action, code } : { action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Co-browsing request failed");
      openDetail();
    } catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setBusy(false); }
  }

  const live = liveStates.has(state.session?.state);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="z-[80] max-h-[min(90vh,560px)] overflow-y-auto sm:max-w-md" overlayClassName="z-[79]" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Co-browsing</DialogTitle>
        <DialogDescription>Page viewing requires consent · control requires a second approval · no recording</DialogDescription>
      </DialogHeader>
      {state.status === "loading" ? <div role="status" aria-label="Loading co-browsing" className="grid gap-3 py-2"><Skeleton className="h-5 w-52"/><Skeleton className="h-10 w-full"/></div>
        : state.status === "error" ? <p role="alert" className="text-sm text-destructive">{state.error}</p>
        : <div className="space-y-4 text-sm">
          {state.error && <p role="alert" className="text-destructive">{state.error}</p>}
          {live ? <>
            <p>{state.session.state === "pending_consent" ? "The request was sent. Waiting for the visitor to accept." : "Page sharing is available in Interaction Details."}</p>
            <button type="button" onClick={openDetail} className="w-full rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground">Open co-browsing tab</button>
          </> : state.entryPoint?.kind === "inSession" ? <>
            <p>This interaction is linked to an active widget session. The visitor must accept before any page content is shared.</p>
            <button type="button" data-testid="cobrowse-request" disabled={busy} onClick={() => void act("request")} className="w-full rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50">{busy ? "Sending request…" : "Request page sharing from visitor"}</button>
          </> : state.entryPoint?.kind === "pairingCode" ? <>
            <p>Ask the visitor to open the widget on the page they want to share, choose “Share this page”, and give you the six-digit code through this interaction. The code does not grant consent.</p>
            <div className="flex gap-2"><input aria-label="Visitor pairing code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2" placeholder="Six-digit code"/>
              <button type="button" data-testid="cobrowse-claim" disabled={busy || code.length !== 6} onClick={() => void act("claim")} className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50">{busy ? "Claiming…" : "Claim code"}</button></div>
          </> : <p>{state.entryPoint?.reason || "Co-browsing is unavailable for this interaction."}</p>}
        </div>}
      <DialogFooter><button type="button" data-testid="cobrowse-close" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm">Close</button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
