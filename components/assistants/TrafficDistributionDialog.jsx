"use client";

import { useEffect, useMemo, useState } from "react";
import { IconTrafficLights, IconTrash } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const versionId = (version) => version?.version_id || version?.version_number || version?.id || "";
const isMain = (version) => version?.is_main_version === true || version?.is_current === true || version?.current === true;

export default function TrafficDistributionDialog({ open, onOpenChange, assistantId, versions }) {
  const [canary, setCanary] = useState(null);
  const [percentages, setPercentages] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const alternatives = useMemo(() => (versions || []).filter((version) => !isMain(version)), [versions]);
  const main = (versions || []).find(isMain);
  const allocated = alternatives.reduce((sum, version) => sum + (Number(percentages[versionId(version)]) || 0), 0);

  useEffect(() => {
    if (!open || !assistantId) return;
    setLoading(true);
    fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/canary-deploys`, { cache: "no-store" }).then((response) => response.json()).then((data) => {
      const next = data?.ok ? data.canary : null; setCanary(next);
      setPercentages(Object.fromEntries((next?.versions || []).map((version) => [version.version_id, version.percentage])));
    }).catch(() => { setCanary(null); setPercentages({}); }).finally(() => setLoading(false));
  }, [assistantId, open]);

  async function clear() {
    setSaving(true);
    try { const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/canary-deploys`, { method: "DELETE" }); if (!response.ok) throw new Error("Could not clear traffic distribution"); setCanary(null); setPercentages({}); onOpenChange(false); notify({ title: "Traffic distribution cleared", description: "100% of traffic now uses the main version.", variant: "success" }); }
    catch (error) { notify({ title: "Could not clear traffic", description: error.message, variant: "error" }); }
    finally { setSaving(false); }
  }

  async function save() {
    const selected = alternatives.filter((version) => Number(percentages[versionId(version)]) > 0).map((version) => ({ version_id: versionId(version), percentage: Number(percentages[versionId(version)]) }));
    if (!selected.length) return clear();
    setSaving(true);
    try { const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/canary-deploys`, { method: canary ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versions: selected }) }); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || "Save failed"); setCanary(data.canary); onOpenChange(false); notify({ title: "Traffic distribution saved", variant: "success" }); }
    catch (error) { notify({ title: "Traffic save failed", description: error.message, variant: "error" }); }
    finally { setSaving(false); }
  }

  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="right" className="flex w-full flex-col overflow-hidden p-0 sm:max-w-lg"><SheetHeader className="border-b px-6 py-5"><SheetTitle className="flex items-center gap-2"><IconTrafficLights className="size-5 text-emerald-500" />Traffic Distribution</SheetTitle></SheetHeader><div className="flex-1 space-y-4 overflow-y-auto p-6">{loading ? <p className="text-sm text-muted-foreground">Loading…</p> : !alternatives.length ? <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No other versions available. Save as New Version first.</p> : <><p className="text-xs text-muted-foreground">Distribute traffic between versions for A/B testing. The remainder stays on the main version.</p><div className="flex items-center justify-between rounded-lg bg-muted p-3"><div><span className="text-sm font-medium">{main?.version_name || "Main version"}</span><Badge variant="outline" className="ml-2 text-xs">Main</Badge></div><strong>{Math.max(0, 100 - allocated)}%</strong></div>{alternatives.map((version, index) => <div key={versionId(version) || index} className="flex items-center gap-3 rounded-lg border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{version.version_name || `Version ${alternatives.length - index}`}</p><p className="text-xs text-muted-foreground">{version.created_at ? new Date(version.created_at).toLocaleDateString() : ""}</p></div><Input className="w-20 text-right" type="number" min="0" max="100" value={percentages[versionId(version)] ?? ""} onChange={(event) => setPercentages((current) => ({ ...current, [versionId(version)]: event.target.value === "" ? 0 : Number(event.target.value) }))} /><span className="text-sm">%</span></div>)}<p className={allocated > 100 ? "text-right text-xs font-medium text-destructive" : "text-right text-xs text-muted-foreground"}>Total allocated: {allocated}%</p></>}</div><SheetFooter className="flex-row gap-2 border-t px-6 py-4">{canary ? <Button variant="outline" onClick={clear} disabled={saving} className="mr-auto"><IconTrash className="size-4" />Clear</Button> : null}<Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button><Button onClick={save} disabled={saving || loading || allocated > 100 || !alternatives.length}>{saving ? "Saving…" : "Save"}</Button></SheetFooter></SheetContent></Sheet>;
}
