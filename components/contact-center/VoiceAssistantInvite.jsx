"use client";
import { useEffect, useRef, useState } from "react";
import { Bot, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useUiText } from "@/components/i18n/use-ui-text";
import { voiceFetch } from "@/lib/telephony/endpoint-client";

export function VoiceAssistantInvite({ interactionId }) {
  const tUi = useUiText();
  const [state, setState] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [selected, setSelected] = useState("");
  const requestRef = useRef(null);
  const endpoint = `/api/contact-center/interactions/${encodeURIComponent(interactionId)}/assistant`;
  useEffect(() => {
    const abort = new AbortController(); let timer;
    async function refresh() {
      try {
        const response = await fetch(endpoint, { signal: abort.signal, cache: "no-store" });
        const data = await response.json(); if (!response.ok) throw new Error(data.error);
        if (!abort.signal.aborted) setState(data);
      } catch (error) { if (!abort.signal.aborted) setError(error.message); }
      if (!abort.signal.aborted) timer = setTimeout(refresh, 2500);
    }
    void refresh(); return () => { abort.abort(); clearTimeout(timer); };
  }, [endpoint]);
  async function act(action) {
    setBusy(true); setError(null);
    try {
      if (action === "invite" && (!requestRef.current || requestRef.current.assistantId !== selected)) requestRef.current = { assistantId: selected, requestId: crypto.randomUUID() };
      const response = await voiceFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "invite" ? { action, ...requestRef.current } : { action, inviteId: state.invite.id }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setState(previous => ({ ...previous, invite: data.invite })); requestRef.current = null;
    } catch (error) { setError(error.message); } finally { setBusy(false); }
  }
  if (!state && !error) return <Skeleton className="h-9 w-64" />;
  if (state && !state.enabled && !state.invite) return null;
  const invite = state?.invite;
  const live = invite && !["ended", "failed"].includes(invite.state);
  return <div className="space-y-1" data-help-id="agent.assistant-invite" data-testid="voice-assistant-invite" data-assistant-state={invite?.state || "idle"}>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Bot className="h-4 w-4" /><span>{tUi("AI assistant")}</span>
      {live ? <>
        <span className="max-w-48 truncate">{invite.name}</span>
        <span className="text-xs text-muted-foreground">{invite.stopping ? tUi("Disconnecting…") : invite.state === "active" ? tUi("Active") : tUi("Connecting…")}</span>
        <Button data-testid="voice-assistant-remove" size="sm" variant="outline" disabled={busy || invite.stopping} onClick={() => act("remove")}><X className="h-4 w-4" />{tUi("Remove assistant")}</Button>
      </> : state?.enabled && <>
        <Select value={selected} onValueChange={value => { setSelected(value); requestRef.current = null; }} disabled={busy}>
          <SelectTrigger data-testid="voice-assistant-select" className="h-8 w-56"><SelectValue placeholder={tUi("Choose an assistant")} /></SelectTrigger>
          <SelectContent>{state.assistants.map(item => <SelectItem data-assistant-id={item.id} key={item.id} value={item.id} disabled={item.unavailable}>{item.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button data-testid="voice-assistant-join" size="sm" variant="outline" disabled={busy || !selected} onClick={() => act("invite")}><UserPlus className="h-4 w-4" />{tUi("Invite assistant")}</Button>
      </>}
    </div>
    {(error || invite?.error) && <p role="alert" className="text-xs text-destructive">{error || invite.error}</p>}
  </div>;
}
