"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconArchive, IconDownload, IconPencil, IconPlus, IconRefresh, IconUpload, IconWorldUpload } from "@tabler/icons-react";
import { AdminPageContent, AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { FormRenderer } from "@/components/forms/FormRenderer";
import { createDefaultForm, slugifyFormName } from "@/lib/forms/form-schema";
import { notify } from "@/components/ToastNotify";

function FormCardSkeleton() {
  return <Card className="overflow-hidden flex flex-col">
    <CardHeader className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-3/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-5 w-14 rounded-full" />
      </div>
    </CardHeader>
    <CardContent className="flex-1">
      <div className="h-56 rounded-xl border p-4">
        <div className="h-full rounded-lg bg-muted/30 p-5 shadow-sm ring-1 ring-border/70 space-y-4">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-5/6" />
          <div className="grid grid-cols-2 gap-3 pt-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>
      </div>
      <Skeleton className="mt-3 h-4 w-4/5" />
      <Skeleton className="mt-2 h-4 w-3/5" />
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2 border-t bg-muted/30 p-3">
      <Skeleton className="h-8 w-16" />
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-8 w-20" />
    </CardFooter>
  </Card>;
}

function formThemeStyle(theme = {}, base = {}) {
  const pairs = [["primary", "--primary"], ["primaryColor", "--primary"], ["primaryForeground", "--primary-foreground"], ["primaryForegroundColor", "--primary-foreground"], ["background", "--background"], ["backgroundColor", "--background"], ["foreground", "--foreground"], ["textColor", "--foreground"], ["card", "--card"], ["cardColor", "--card"], ["cardForeground", "--card-foreground"], ["border", "--border"], ["borderColor", "--border"], ["accent", "--accent"], ["accentColor", "--accent"], ["accentForeground", "--accent-foreground"], ["muted", "--muted"], ["mutedColor", "--muted"]];
  return pairs.reduce((style, [key, variable]) => theme?.[key] ? { ...style, [variable]: theme[key] } : style, base);
}
function themeColor(theme = {}, ...keys) { return keys.map((key) => theme?.[key]).find(Boolean); }
function formPreviewStyle(form = {}) {
  const theme = form.theme || {};
  const primary = themeColor(theme, "primary", "primaryColor", "pageTabActiveBorderColor") || "var(--primary)";
  const background = themeColor(theme, "background", "backgroundColor") || "var(--background)";
  const border = themeColor(theme, "border", "borderColor", "pageTabActiveBorderColor") || "var(--border)";
  return { ...formThemeStyle(theme), background: `linear-gradient(135deg, color-mix(in srgb, ${primary} 14%, transparent), ${background} 44%)`, borderColor: border };
}

export default function AdminFormsPage() {
  const router = useRouter();
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [formsLoading, setFormsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const importInputRef = useRef(null);

  async function load({ showSkeleton = false, showRefreshing = false, showSuccessToast = false } = {}) {
    if (showSkeleton) setFormsLoading(true);
    if (showRefreshing) setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (showArchived) params.set("status", "all");
      const query = params.toString();
      const res = await fetch(`/api/admin/forms${query ? `?${query}` : ""}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Please try again.");
      setForms(data.forms || []);
      if (showSuccessToast) notify({ title: "Forms refreshed", description: "The forms list is up to date.", variant: "success" });
    } catch (err) {
      notify({ title: "Failed to load forms", description: err.message || "Please try again.", variant: "error" });
    } finally {
      if (showSkeleton) setFormsLoading(false);
      if (showRefreshing) setRefreshing(false);
    }
  }

  useEffect(() => { load({ showSkeleton: true }); }, [showArchived]);

  async function createForm() {
    setLoading(true);
    try {
      const draft = createDefaultForm({ name: "New agent form", slug: `${slugifyFormName("New agent form")}-${Date.now().toString(36)}` });
      const res = await fetch("/api/admin/forms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to create form");
      router.push(`/admin/forms/${data.form.id}`);
    } catch (err) {
      notify({ title: "Failed to create form", description: err.message || "Please try again.", variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function archiveForm(form) {
    setArchiveTarget(form);
  }

  async function confirmArchiveForm() {
    if (!archiveTarget) return;
    const form = archiveTarget;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/forms/${form.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Archive failed");
      notify({ title: "Form archived", description: `“${form.name}” is now archived.`, variant: "success" });
      setArchiveTarget(null);
      await load();
    } catch (err) {
      notify({ title: "Archive failed", description: err.message || "Please try again.", variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function publishForm(form) {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/forms/${form.id}/publish`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Publish failed");
      notify({ title: "Form published", description: `“${form.name}” is now published.`, variant: "success" });
      await load();
    } catch (err) {
      notify({ title: "Publish failed", description: err.message || "Please try again.", variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function exportForm(form) {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/forms/${form.id}/export`, { cache: "no-store" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Export failed");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `${form.slug || "form"}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify({ title: "Form exported", description: `Downloaded ${filename}.`, variant: "success" });
    } catch (err) {
      notify({ title: "Export failed", description: err.message || "Please try again.", variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function importFormFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setLoading(true);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const res = await fetch("/api/admin/forms/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.details?.[0]?.message || data.error || "Import failed");
      notify({ title: "Form imported", description: `Created “${data.form?.name || "imported form"}” as a draft${data.importedMediaCount ? ` and registered ${data.importedMediaCount} media reference${data.importedMediaCount === 1 ? "" : "s"}` : ""}.`, variant: "success" });
      await load();
    } catch (err) {
      notify({ title: "Import failed", description: err.message || "Please select a valid form JSON export.", variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  const headerActions = <>
    <div className="flex items-center gap-2 rounded-md border bg-background/70 px-3 py-2">
      <Switch id="show-archived-forms" checked={showArchived} onCheckedChange={setShowArchived} disabled={formsLoading || refreshing} />
      <label htmlFor="show-archived-forms" className="text-sm font-medium leading-none">Show Archived</label>
    </div>
    <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={importFormFile} />
    <Button size="sm" variant="outline" onClick={() => load({ showRefreshing: true, showSuccessToast: true })} disabled={loading || formsLoading || refreshing}><IconRefresh className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />Refresh</Button>
    <Button size="sm" variant="outline" onClick={() => importInputRef.current?.click()} disabled={loading}><IconUpload className="h-4 w-4 mr-2" />Import JSON</Button>
    <Button size="sm" onClick={createForm} disabled={loading}><IconPlus className="h-4 w-4 mr-2" />New form</Button>
  </>;

  return <AdminPageShell>
    <AdminPageHeader title="Agent Forms" badges={<Badge variant="secondary">{forms.length} forms</Badge>} actions={headerActions} />
    <AdminPageContent>
      <div className="space-y-5">
    <AlertDialog open={Boolean(archiveTarget)} onOpenChange={(open) => { if (!open && !loading) setArchiveTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive form?</AlertDialogTitle>
          <AlertDialogDescription>
            Archive “{archiveTarget?.name || "this form"}”? It will be hidden from published form lists, but can still be restored from archived records.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirmArchiveForm} disabled={loading} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Archive form</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>


    {formsLoading ? <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => <FormCardSkeleton key={index} />)}
    </div> : null}

    {!formsLoading && forms.length === 0 ? <Card><CardContent className="p-10 text-center"><h2 className="font-medium">{showArchived ? "No forms yet" : "No active forms"}</h2><p className="mt-1 text-sm text-muted-foreground">{showArchived ? "Create the first form, then refine it in the visual builder or with the AI agent." : "Archived forms are hidden by default. Enable Show Archived to include them."}</p><Button className="mt-4" onClick={createForm}>Create form</Button></CardContent></Card> : null}

    {!formsLoading ? <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {forms.map((form) => <Card key={form.id} className="overflow-hidden flex flex-col">
        <CardHeader className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><CardTitle className="text-base truncate">{form.name}</CardTitle><p className="text-xs text-muted-foreground truncate">{form.slug}</p></div>
            <Badge variant={form.status === "published" ? "default" : "outline"}>{form.status}</Badge>
          </div>
          <div className="flex flex-wrap gap-1 text-xs">{form.category ? <Badge variant="secondary">{form.category}</Badge> : null}{(form.queue_names || []).slice(0, 2).map((queue) => <Badge key={queue} variant="outline">{queue}</Badge>)}{(form.queue_names || []).length > 2 ? <Badge variant="outline">+{form.queue_names.length - 2}</Badge> : null}</div>
        </CardHeader>
        <CardContent className="flex-1">
          <div className="h-56 overflow-hidden rounded-xl border p-4" style={formPreviewStyle(form)}>
            <div className="origin-top-left scale-[0.72] w-[135%] pointer-events-none rounded-lg bg-background p-5 text-foreground shadow-sm ring-1 ring-border/70" style={formThemeStyle(form.theme)}>
              <FormRenderer form={form} readOnly />
            </div>
          </div>
          {form.description ? <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{form.description}</p> : null}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2 border-t bg-muted/30 p-3">
          <Button size="sm" onClick={() => router.push(`/admin/forms/${form.id}`)}><IconPencil className="h-4 w-4 mr-1" />Edit</Button>
          <Button size="sm" variant="outline" onClick={() => publishForm(form)} disabled={loading || form.status === "published"}><IconWorldUpload className="h-4 w-4 mr-1" />Publish</Button>
          <Button size="sm" variant="outline" onClick={() => exportForm(form)} disabled={loading}><IconDownload className="h-4 w-4 mr-1" />Export</Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => archiveForm(form)} disabled={loading || form.status === "archived"}><IconArchive className="h-4 w-4 mr-1" />Archive</Button>
        </CardFooter>
      </Card>)}
    </div> : null}
      </div>
    </AdminPageContent>
  </AdminPageShell>;
}
