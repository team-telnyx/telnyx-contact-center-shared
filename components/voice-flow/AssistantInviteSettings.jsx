"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export function AssistantInviteSettings({ config, onChange }) {
  const tUi = useUiText();
  const [items, setItems] = useState(null), [error, setError] = useState(null), [search, setSearch] = useState(""), [revision, setRevision] = useState(0);
  const [checks, setChecks] = useState({});
  const requests = useRef(new Map());
  const latest = useRef({ config, onChange });
  useLayoutEffect(() => { latest.current = { config, onChange }; }, [config, onChange]);
  const enabled = config.enable_assistant_invite === true;
  const selected = config.invite_assistant_ids || [];
  const visibleItems = items && [...items, ...selected.filter(id => !items.some(item => item.id === id)).map(id => ({ id, name: id, unavailable: true }))];
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const pending = requests.current;
    fetch("/api/voice/flows/assistant-invite-options", { signal: abort.signal, cache: "no-store" })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data.items; })
      .then(items => { if (!abort.signal.aborted) setItems(items); }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => { abort.abort(); for (const request of pending.values()) request.abort(); pending.clear(); };
  }, [enabled, revision]);

  function updateSelection(id, checked) {
    const { config: current, onChange: change } = latest.current;
    if (checked && (current.enabled === false || !current.enable_assistant_invite)) return;
    const ids = current.invite_assistant_ids || [];
    const next = { ...current, invite_assistant_ids: checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id) };
    latest.current = { config: next, onChange: change };
    change(next);
  }

  async function checkAssistant(id) {
    if (requests.current.has(id)) return;
    const abort = new AbortController(); requests.current.set(id, abort);
    setChecks(previous => ({ ...previous, [id]: { status: "checking" } }));
    try {
      const response = await fetch(`/api/voice/flows/assistant-invite-options?assistantId=${encodeURIComponent(id)}`, { signal: abort.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.item?.id !== id || typeof data.item?.skipTurn !== "boolean") throw new Error(data.error || "Could not verify this assistant's Skip Turn tool. Try again.");
      if (abort.signal.aborted) return;
      setChecks(previous => ({ ...previous, [id]: { status: data.item.skipTurn ? "valid" : "missing" } }));
      if (data.item.skipTurn) updateSelection(id, true);
    } catch (error) {
      if (!abort.signal.aborted) setChecks(previous => ({ ...previous, [id]: { status: "error", error: error.message } }));
    } finally { if (requests.current.get(id) === abort) requests.current.delete(id); }
  }

  return <section data-help-id="admin.call-flows.assistant-invite" data-testid="assistant-invite-settings" className="space-y-3 rounded-lg border p-3">
    <label className="flex items-center justify-between gap-3 text-sm font-medium">
      {tUi("Enable assistant invite")}
      <Switch checked={enabled} disabled={config.enabled === false} onCheckedChange={value => { setItems(null); setChecks({}); setError(null); onChange({ ...config, enable_assistant_invite: value }); }} />
    </label>
    <p className="text-xs text-muted-foreground">{tUi("Let agents invite a selected AI assistant to speak with both participants. Each assistant must have the Skip Turn tool.")}</p>
    {enabled && <>
      <p className="text-xs text-muted-foreground">{tUi("Saving this call flow prepares the selected assistants for live transcription in this environment.")}</p>
      <Input aria-label={tUi("Search assistants")} placeholder={tUi("Search assistants")} value={search} onChange={event => setSearch(event.target.value)} />
      {error ? <div role="alert" className="text-xs text-destructive">{error} <Button size="sm" variant="outline" onClick={() => { setError(null); setItems(null); setRevision(value => value + 1); }}>{tUi("Retry")}</Button></div>
        : !items ? <div className="space-y-2">{[0, 1, 2].map(id => <Skeleton key={id} className="h-10 w-full" />)}</div>
          : <div className="max-h-[240px] overflow-y-auto rounded-md border">
            {visibleItems.filter(item => item.name.toLowerCase().includes(search.trim().toLowerCase())).map(item => {
              const check = checks[item.id], pending = check?.status === "checking", invalid = ["missing", "error"].includes(check?.status);
              return <div key={item.id} data-assistant-id={item.id} className="flex h-12 items-center gap-2 border-b px-2 last:border-b-0">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <Checkbox aria-label={item.name} checked={selected.includes(item.id)} disabled={config.enabled === false || pending || ((item.unavailable || invalid) && !selected.includes(item.id))} onCheckedChange={checked => checked ? void checkAssistant(item.id) : updateSelection(item.id, false)} />
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="flex items-center gap-2"><span className="truncate" title={item.name}>{item.name}</span>
                      {pending && <span role="status" className="shrink-0"><Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /><span className="sr-only">{tUi("Checking…")}</span></span>}
                      {check?.status === "valid" && <CheckCircle2 aria-label={tUi("Verified")} className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
                    </span>
                    {(item.unavailable || invalid) && <span role="status" className="block truncate text-amber-600" title={check?.error}>{item.unavailable ? tUi("Unavailable") : check?.status === "missing" ? tUi("Add Skip Turn in the assistant's Tools settings.") : check.error}</span>}
                  </span>
                </label>
                {invalid && !item.unavailable && <Button type="button" size="sm" variant="ghost" disabled={config.enabled === false} onClick={() => void checkAssistant(item.id)}>{tUi("Retry")}</Button>}
              </div>;
            })}
            {!visibleItems.some(item => item.name.toLowerCase().includes(search.trim().toLowerCase())) && <p className="p-3 text-sm text-muted-foreground">{tUi("No assistants found")}</p>}
          </div>}
      {items && selected.some(id => !items.some(item => item.id === id) || checks[id]?.status === "missing") && <p role="alert" className="text-xs text-destructive">{tUi("A selected assistant is unavailable or has no Skip Turn tool. Update the selection before saving.")}</p>}
    </>}
  </section>;
}
