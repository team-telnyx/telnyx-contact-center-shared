"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { CONFIGURABLE_CHANNELS, RELEASED_CHANNELS, defaultChannelPolicy } from "@/lib/acd/channel-policy.mjs";

const LABELS = { voice: "Voice / WebRTC", chat: "Chat", email: "Email", whatsapp: "WhatsApp", sms: "SMS", video: "Video (web widget)" };

export function useChannelUtilization(scope, subjectId, open) {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    // A reopened editor must discard its previous unsaved form state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError("");
    setSettings(null);
    if (!open) return;
    if (!subjectId) {
      setSettings({ policies: CONFIGURABLE_CHANNELS.map(defaultChannelPolicy), budget: 1, releasedChannels: RELEASED_CHANNELS, revision: null });
      return;
    }
    fetch(`/api/admin/utilization/${scope}/${encodeURIComponent(subjectId)}`, { cache: "no-store" })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error); return body; })
      .then(body => { if (!cancelled) setSettings(body); })
      .catch(reason => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [scope, subjectId, open]);
  return { settings, setSettings, error, ready: Boolean(settings) && !error,
    payload: settings ? { policies: settings.policies, budget: settings.budget, expectedRevision: settings.revision } : null };
}

export default function ChannelUtilization({ scope, form, disabled = false }) {
  const { settings, setSettings, error } = form;
  const saving = disabled;
  function update(channel, key, value) {
    setSettings(current => ({ ...current, policies: current.policies.map(p => p.channel === channel ? { ...p, [key]: value } : p) }));
  }
  return <section className="mx-5 my-4 space-y-4 rounded-xl border bg-card p-6" aria-label="Channels and utilization">
    <div><h3 className="text-sm font-semibold">Channels &amp; Utilization</h3>
      <p className="mt-1 text-xs text-muted-foreground">{scope === "agent"
        ? "Enable the channels this agent is trained to handle. Limits apply across all queues and browser sessions."
        : "Enable channels on this queue and set the maximum offered to each agent. The lower agent or queue limit applies to the agent's total workload."}</p></div>
    {!settings && !error ? <p className="text-sm text-muted-foreground">Loading channel settings…</p> : null}
    {settings && <>
      {scope === "agent" && <label className="flex items-center justify-between gap-3 text-sm">Total capacity budget
        <span className="flex items-center gap-1"><Input aria-label="Total capacity budget percent" type="number" min="1" max="100" className="w-20" disabled={disabled}
          value={Math.round(settings.budget*100)} onChange={event => setSettings(current => ({ ...current,budget:Number(event.target.value)/100 }))} />%</span></label>}
      <div className="grid grid-cols-[minmax(0,1fr)_70px_78px] items-center gap-2">
        <span className="text-xs text-muted-foreground">Channel</span><span className="text-xs text-muted-foreground">Max. active</span><span className="text-xs text-muted-foreground">Capacity %</span>
        {settings.policies.map(p => <div key={p.channel} className="contents">
          <label className="flex min-w-0 items-center gap-2 py-2 text-xs"><Switch aria-label={`Enable ${LABELS[p.channel]}`} checked={p.enabled}
            disabled={saving || !settings.releasedChannels.includes(p.channel)} onCheckedChange={value => update(p.channel,"enabled",value)} />
            <span>{LABELS[p.channel]}{!settings.releasedChannels.includes(p.channel) && <Badge variant="secondary" className="ml-1 text-[9px]">Planned</Badge>}</span></label>
          <Input type="number" min="1" max="100" aria-label={`${LABELS[p.channel]} maximum concurrent interactions`} value={p.maxConcurrent}
            disabled={saving || !p.enabled || p.channel === "voice"} onChange={event => update(p.channel,"maxConcurrent",Number(event.target.value))} />
          <Input type="number" min="1" max="100" aria-label={`${LABELS[p.channel]} capacity percent`} value={Math.round(p.weight*100)}
            disabled={saving || !p.enabled || p.channel === "voice"} onChange={event => update(p.channel,"weight",Number(event.target.value)/100)} />
        </div>)}
      </div>
      <p className="text-xs text-muted-foreground">Offers, active interactions and required wrap-up occupy capacity. Voice uses the entire agent. Text interactions share the remaining budget.</p>
      <p className="text-xs text-muted-foreground">Saved together with the other settings using the button below.</p>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
