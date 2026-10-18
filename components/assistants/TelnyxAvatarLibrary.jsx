"use client";
import * as Tabs from "@radix-ui/react-tabs";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { assistantTabListClass, assistantTabTriggerClass } from "./AssistantSectionTabs";
import { useEffect, useRef, useState } from "react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { drawAvatarPreview, isAvatarImageFile } from "@/lib/ai/avatar-preview.mjs";

// Shared catalog for assistant settings and both widget media channels. The
// avatar ID is durable; catalog reads refresh the provider's signed previews.
export default function TelnyxAvatarLibrary({ selectedId, onSelect, carousel = false }) {
  const tUi = useUiText();
  const [catalog, setCatalog] = useState({ status: "loading", entries: [] });
  const [revision, reload] = useState(0);
  const [type, setType] = useState("stock");
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [file, setFile] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const previewCanvas = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renameId, setRenameId] = useState("");
  const [rename, setRename] = useState("");
  const refreshed = useRef(new Set());
  const strip = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ai/avatars", { cache: "no-store", signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load avatars");
      if (!controller.signal.aborted) setCatalog({ status: "ready", entries: data.avatars });
    }).catch(e => { if (!controller.signal.aborted) setCatalog({ status: "error", entries: [], error: e.message }); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!file || !previewCanvas.current) return;
    const controller = new AbortController();
    drawAvatarPreview(previewCanvas.current, file, { signal: controller.signal })
      .then(drawn => { if (drawn) setPreviewReady(true); })
      .catch(() => { if (!controller.signal.aborted) { setError(tUi("Invalid image data")); setFile(null); setPreviewReady(false); } });
    return () => controller.abort();
  }, [file, tUi]);
  async function save(method, body) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/ai/avatars", { method, ...(method === "PATCH" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { body }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Avatar operation failed");
      onSelect(data.avatar); setFile(null); setPreviewReady(false); setName(""); setRenameId(""); reload(r => r + 1);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const visible = catalog.entries.filter(a => a.type === type && a.name.toLowerCase().includes(search.toLowerCase()));
  const count = catalog.entries.filter(a => a.type === type).length;
  return <Tabs.Root value={type} onValueChange={value=>{setType(value);setSearch("");strip.current?.scrollTo({left:0});}} className="min-w-0 space-y-3" data-telnyx-avatar-library>
    {carousel && <h3 className="flex items-center gap-2 text-sm font-medium">{tUi("Choose an avatar")}
      {catalog.status === "loading" ? <Skeleton className="h-4 w-20"/> : catalog.status === "ready" && <span className="text-muted-foreground" aria-live="polite">({count} {tUi(type === "stock" ? "Stock avatars" : "Custom avatars")})</span>}
    </h3>}
    <div className="flex items-center gap-2">
      <Tabs.List className={assistantTabListClass} aria-label={tUi("Avatar library")}>
        {["stock", "custom"].map(value => <Tabs.Trigger key={value} value={value} className={assistantTabTriggerClass}>{tUi(value === "stock" ? "Stock avatars" : "Custom avatars")}</Tabs.Trigger>)}
      </Tabs.List>
      <Button type="button" variant="ghost" size="sm" onClick={() => { refreshed.current.clear(); setCatalog(c => ({ ...c, status: "loading" })); reload(r => r + 1); }}>{tUi("Refresh")}</Button>
    </div>
    <Tabs.Content value={type} className="min-w-0 space-y-3 outline-none">
    <Input aria-label={tUi("Search avatars")} placeholder={tUi("Search avatars")} value={search} onChange={e => setSearch(e.target.value)} />
    {catalog.status === "loading" ? <div className={carousel ? "grid grid-cols-5 gap-2" : "grid grid-cols-3 gap-2"} role="status" aria-label={tUi("Loading avatars")}>
      {Array.from({ length: carousel ? 5 : 6 }, (_, i) => <Skeleton key={i} className="aspect-video rounded-lg" />)}
    </div> : catalog.status === "error" ? <p role="alert" className="text-sm text-destructive">{catalog.error}</p> : <>
      {carousel && visible.length > 0 && <div className="flex justify-end gap-1">
        <Button type="button" variant="outline" size="icon" aria-label={tUi("Previous avatars")} onClick={()=>strip.current?.scrollBy({left:-strip.current.clientWidth,behavior:"smooth"})}><ChevronLeft className="size-4"/></Button>
        <Button type="button" variant="outline" size="icon" aria-label={tUi("Next avatars")} onClick={()=>strip.current?.scrollBy({left:strip.current.clientWidth,behavior:"smooth"})}><ChevronRight className="size-4"/></Button>
      </div>}
      <div ref={strip} tabIndex={carousel ? 0 : undefined} aria-label={tUi("Available avatars")} data-avatar-strip={carousel || undefined}
        className={carousel ? "flex w-full gap-2 overflow-x-auto overscroll-x-contain scroll-smooth snap-x snap-mandatory px-1 py-2" : "grid max-h-96 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3"}>
        {visible.map(entry => <div key={entry.id} className="min-w-0 snap-start" style={carousel ? {flex:"0 0 calc((100% - 2rem) / 5)",minWidth:120} : undefined}>
          <button type="button" aria-pressed={selectedId === entry.id} onClick={() => onSelect(entry)} className={`w-full overflow-hidden rounded-lg border text-left ${selectedId === entry.id ? "ring-2 ring-emerald-500" : ""}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={entry.previewUrl} alt={entry.name} className="aspect-video w-full bg-muted object-cover" onError={() => {
              if (!refreshed.current.has(entry.id)) { refreshed.current.add(entry.id); reload(r => r + 1); }
            }} />
            <span className="block truncate p-2 text-xs">{entry.name}</span>
          </button>
          {entry.type === "custom" && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setRenameId(entry.id); setRename(entry.name); }}>{tUi("Rename")}</Button>}
        </div>)}
      </div>
      {!visible.length && <p className="text-sm text-muted-foreground">{tUi("No avatars found")}</p>}
    </>}
    {renameId && <div className="flex gap-2"><Input aria-label={tUi("Avatar name")} value={rename} maxLength={255} onChange={e => setRename(e.target.value)} /><Button type="button" disabled={busy || !rename.trim()} onClick={() => save("PATCH", { id: renameId, name: rename })}>{tUi("Save name")}</Button></div>}
    {type === "custom" && <div className="space-y-2 rounded-lg border p-3">
      <Label>{tUi("Create an avatar from an image")}</Label>
      <Input value={name} aria-label={tUi("Avatar name")} placeholder={tUi("Avatar name")} maxLength={255} onChange={e => setName(e.target.value)} />
      <Input type="file" aria-label={tUi("Avatar image")} accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => { const f = e.target.files?.[0]; setError(""); setPreviewReady(false); if (f && !isAvatarImageFile(f)) { setError(tUi("Choose a JPEG, PNG or WebP image up to 10 MiB")); setFile(null); e.target.value = ""; return; } setFile(f || null); }} />
      {file && <>{!previewReady && <Skeleton className="h-40 w-40 rounded" />}<canvas ref={previewCanvas} role="img" aria-label={tUi("Avatar preview")} hidden={!previewReady} className="max-h-40 rounded" /></>}
      <p className="text-xs text-muted-foreground">{tUi("JPEG, PNG or WebP, up to 10 MiB. Each side: 256–8192 pixels; at most 40 megapixels. Use one centered, front-facing person.")}</p>
      <p className="text-xs text-muted-foreground">{tUi("Telnyx allows 20 custom avatars per organization. Uploaded avatars cannot currently be deleted; replacing an image uses a new slot.")}</p>
      <Button type="button" disabled={busy || !file || !previewReady || !name.trim()} onClick={() => { const form = new FormData(); form.set("name", name); form.set("image_file", file); save("POST", form); }}>{tUi(busy ? "Uploading…" : "Create avatar")}</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </Tabs.Content>
  </Tabs.Root>;
}
