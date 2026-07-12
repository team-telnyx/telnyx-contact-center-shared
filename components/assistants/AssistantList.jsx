"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconCheck,
  IconCopy,
  IconLayoutGrid,
  IconListDetails,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconTrash,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { AiAssistantsSectionPage } from "@/components/assistants/AiAssistantsSectionNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const PAGE_SIZES = [12, 24, 48];

function modelName(assistant) {
  return assistant?.model || assistant?.llm_model || assistant?.llm || "—";
}

function ttsProvider(assistant) {
  const settings = assistant?.voice_settings || {};
  const value = settings.tts_provider || settings.provider || assistant?.voice || assistant?.tts_provider || "";
  return String(value).split(/[./]/)[0]?.toUpperCase() || "—";
}

function sttProvider(assistant) {
  const value = assistant?.transcription?.model || assistant?.transcription_settings?.model || "";
  return String(value).split(/[./]/)[0]?.toUpperCase() || "—";
}

function CopyIdButton({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy(event) {
    event.stopPropagation();
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <button type="button" onClick={copy} className="text-muted-foreground transition hover:text-foreground" title="Copy assistant ID">
      {copied ? <IconCheck className="size-3.5 text-emerald-500" /> : <IconCopy className="size-3.5" />}
    </button>
  );
}

export default function AssistantList() {
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [models, setModels] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [filters, setFilters] = useState({ name: "", id: "", model: "" });
  const [view, setView] = useState("list");
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    Object.entries(filters).forEach(([key, value]) => value && params.set(key, value));
    return params.toString();
  }, [filters, page, pageSize]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/ai/assistants?${query}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) throw new Error(data?.error || "Failed to load assistants");
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(Number(data.total || 0));
    } catch (error) {
      setItems([]);
      notify({ title: "Could not load assistants", description: error.message, variant: "error" });
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch("/api/ai/models", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setModels(Array.isArray(data.models) ? data.models : []))
      .catch(() => setModels([]));
  }, []);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  async function deleteAssistant() {
    if (!deleteTarget?.id) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/ai/assistants/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) throw new Error(data?.error || "Delete failed");
      notify({ title: "Assistant deleted", description: deleteTarget.name || deleteTarget.id, variant: "success" });
      setDeleteTarget(null);
      await load();
    } catch (error) {
      notify({ title: "Delete failed", description: error.message, variant: "error" });
    } finally {
      setDeleting(false);
    }
  }

  const actions = (
    <>
      <Button variant="outline" onClick={load} disabled={loading}><IconRefresh className="size-4" />Refresh</Button>
      <Button onClick={() => router.push("/admin/ai-assistants/new")}><IconPlus className="size-4" />Add assistant</Button>
    </>
  );

  return (
    <AdminPageShell>
      <AdminPageHeader title="AI Assistants" icon={IconRobot} badges={<Badge variant="secondary">{total} assistants</Badge>} actions={actions} />
      <AiAssistantsSectionPage activeId="assistants">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr_auto]">
              <Input value={filters.name} onChange={(event) => updateFilter("name", event.target.value)} placeholder="Filter by name" aria-label="Filter by assistant name" />
              <Input value={filters.id} onChange={(event) => updateFilter("id", event.target.value)} placeholder="Filter by ID" aria-label="Filter by assistant ID" />
              <Select value={filters.model || "all"} onValueChange={(value) => updateFilter("model", value === "all" ? "" : value)}>
                <SelectTrigger><SelectValue placeholder="All models" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All models</SelectItem>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent>
              </Select>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setFilters({ name: "", id: "", model: "" }); setPage(1); }}>Clear</Button>
                <Button variant={view === "list" ? "default" : "outline"} size="icon" onClick={() => setView("list")} title="List view"><IconListDetails className="size-4" /></Button>
                <Button variant={view === "cards" ? "default" : "outline"} size="icon" onClick={() => setView("cards")} title="Card view"><IconLayoutGrid className="size-4" /></Button>
              </div>
            </div>

            {loading ? (
              <div className="space-y-2">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>
            ) : view === "list" ? (
              <div className="overflow-x-auto rounded-lg border">
                <Table className="min-w-[900px]">
                  <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>ID</TableHead><TableHead>Model</TableHead><TableHead>TTS</TableHead><TableHead>STT</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {items.map((assistant) => (
                      <TableRow key={assistant.id} className="cursor-pointer" onClick={() => router.push(`/admin/ai-assistants/${encodeURIComponent(assistant.id)}`)}>
                        <TableCell><div className="flex items-center gap-2 font-medium"><IconRobot className="size-4 text-amber-500" />{assistant.name || "Untitled assistant"}</div></TableCell>
                        <TableCell><div className="flex items-center gap-2 font-mono text-xs"><span className="max-w-64 truncate">{assistant.id}</span><CopyIdButton value={assistant.id} /></div></TableCell>
                        <TableCell className="max-w-60 truncate">{modelName(assistant)}</TableCell>
                        <TableCell>{ttsProvider(assistant)}</TableCell><TableCell>{sttProvider(assistant)}</TableCell>
                        <TableCell><div className="inline-flex w-full items-center justify-end gap-2"><button type="button" className="inline-flex items-center text-telnyx-green" title="Edit assistant" aria-label={`Edit ${assistant.name || "assistant"}`} onClick={(event) => { event.stopPropagation(); router.push(`/admin/ai-assistants/${encodeURIComponent(assistant.id)}`); }}><IconPencil className="size-4" /></button><button type="button" className="inline-flex items-center text-red-500 hover:text-red-700" title="Delete assistant" aria-label={`Delete ${assistant.name || "assistant"}`} onClick={(event) => { event.stopPropagation(); setDeleteTarget(assistant); }}><IconTrash className="size-4" /></button></div></TableCell>
                      </TableRow>
                    ))}
                    {!items.length && <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">No assistants match the current filters.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {items.map((assistant) => (
                  <Card key={assistant.id} className="cursor-pointer transition hover:border-foreground/25 hover:shadow-md" onClick={() => router.push(`/admin/ai-assistants/${encodeURIComponent(assistant.id)}`)}>
                    <CardContent className="space-y-3 pt-5"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-2 font-semibold"><IconRobot className="size-5 shrink-0 text-amber-500" /><span className="truncate">{assistant.name || "Untitled assistant"}</span></div><Button variant="ghost" size="icon" className="shrink-0 text-destructive" onClick={(event) => { event.stopPropagation(); setDeleteTarget(assistant); }}><IconTrash className="size-4" /></Button></div><div className="flex items-center gap-2 font-mono text-xs text-muted-foreground"><span className="truncate">{assistant.id}</span><CopyIdButton value={assistant.id} /></div><div className="grid grid-cols-3 gap-2 text-xs"><div><div className="text-muted-foreground">Model</div><div className="truncate font-medium" title={modelName(assistant)}>{modelName(assistant)}</div></div><div><div className="text-muted-foreground">TTS</div><div className="font-medium">{ttsProvider(assistant)}</div></div><div><div className="text-muted-foreground">STT</div><div className="font-medium">{sttProvider(assistant)}</div></div></div></CardContent>
                  </Card>
                ))}
                {!items.length && <div className="col-span-full rounded-lg border p-10 text-center text-sm text-muted-foreground">No assistants match the current filters.</div>}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Page {page} of {pageCount} · {total} total</span>
              <div className="flex items-center gap-2"><Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger><SelectContent>{PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} rows</SelectItem>)}</SelectContent></Select><Button variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button variant="outline" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>Next</Button></div>
            </div>
          </CardContent>
        </Card>
      </AiAssistantsSectionPage>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete assistant?</AlertDialogTitle><AlertDialogDescription>This permanently deletes {deleteTarget?.name || deleteTarget?.id} from Telnyx. This action cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleting} onClick={deleteAssistant}>{deleting ? "Deleting…" : "Delete"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </AdminPageShell>
  );
}
