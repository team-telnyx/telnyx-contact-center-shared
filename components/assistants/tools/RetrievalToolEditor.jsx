"use client";
import { useUiText } from "@/components/i18n/use-ui-text";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Combobox from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IconX } from "@tabler/icons-react";
export default function RetrievalToolEditor({ value, onChange }) {
  const t = useUiText();
  const config = value?.retrieval || {};
  const selected = config.bucket_ids || [];
  const [catalog, setCatalog] = useState({ loading: true, buckets: [], error: "" });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setCatalog(current => ({ ...current, loading: true, error: "" }));
      try {
        const response = await fetch("/api/storage/embeddings/buckets", { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok || !Array.isArray(body.data?.buckets)) throw new Error("catalog unavailable");
        const buckets = body.data.buckets.map(item => typeof item === "string" ? item : item.name || item.bucket_name || item.id).filter(Boolean);
        if (!controller.signal.aborted) setCatalog({ loading: false, buckets: [...new Set(buckets)], error: "" });
      } catch {
        if (!controller.signal.aborted) setCatalog({ loading: false, buckets: [], error: "Knowledge sources could not be loaded. Your selected sources are unchanged. Try again." });
      }
    }
    load();
    return () => controller.abort();
  }, [reload]);
  const update = patch => onChange({ ...value, retrieval: { ...config, ...patch } });
  return <div className="space-y-5">
    <div className="space-y-2"><Label>{t("Knowledge sources")}</Label><p className="text-xs text-muted-foreground">{t("Choose embedded Telnyx Storage buckets for the assistant to search.")}</p>
      <div className="flex flex-wrap gap-2">{selected.map(id => <span key={id} className="inline-flex max-w-full items-center gap-2 rounded-md border px-3 py-1.5 text-sm"><span className="truncate">{id}</span><button type="button" aria-label={t("Remove {value0}", { value0: id })} onClick={() => update({ bucket_ids: selected.filter(item => item !== id) })}><IconX className="size-4" /></button></span>)}</div>
    </div>
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
      <div className="space-y-2"><Label>{t("Add knowledge source")}</Label>
        {catalog.loading ? <Skeleton className="h-10 w-full" /> : catalog.error ? <div className="space-y-2" role="alert"><p className="text-sm text-destructive">{t(catalog.error)}</p><Button type="button" size="sm" variant="outline" onClick={() => setReload(v => v + 1)}>{t("Try again")}</Button></div> : catalog.buckets.length ? <Combobox value="" options={catalog.buckets.filter(id => !selected.includes(id)).map(id => ({ value: id, label: id }))} onChange={id => { if (id && !selected.includes(id)) update({ bucket_ids: [...selected, id] }); }} placeholder={t("Choose a knowledge source")} emptyLabel={t("No more knowledge sources available")} triggerClassName="w-full" contentClassName="w-[min(400px,80vw)]" searchable /> : <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{t("No embedded knowledge sources yet. Embed a bucket in Telnyx Storage, then refresh this list.")} <button type="button" className="underline" onClick={() => setReload(v => v + 1)}>{t("Refresh")}</button></p>}
      </div>
      <div className="space-y-2"><Label htmlFor="retrieval-results">{t("Maximum results")}</Label><Input id="retrieval-results" type="number" min={1} step={1} value={config.max_num_results ?? 3} onChange={e => update({ max_num_results: Number(e.target.value) })} /></div>
    </div>
  </div>;
}
