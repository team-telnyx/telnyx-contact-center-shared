"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconCalendarClock, IconCheck, IconPlus, IconRefresh, IconTrash, IconX } from "@tabler/icons-react";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { SystemSectionPage } from "@/components/admin/SystemSectionNav";
import { useUiText } from "@/components/i18n/use-ui-text";
import { useAuth, Can } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import ExceptionCalendarEditor from "@/components/schedules/ExceptionCalendarEditor";
import { ScheduleTester, TimeZoneField, WeeklyHoursEditor, schedulesApi } from "@/components/schedules/ScheduleFields";
import { WEEKDAYS, defaultWeekly, defaultScheduleConfig, normalizeResource } from "@/lib/schedules/evaluator.mjs";
import { cn } from "@/lib/utils";
import { notify } from "@/components/ToastNotify";

function newResource(kind) {
  const year = new Date().getFullYear();
  return { kind, name: "", description: "", definition: kind === "schedule" ? { timeZone: "Europe/Warsaw", weekly: defaultWeekly() } : { coverageStart: `${year}-01-01`, coverageEnd: `${year + 1}-12-31`, entries: [] } };
}

function editorFor(kind, record = null) {
  const draft = record?.draft || newResource(kind);
  return { key: record?.id || crypto.randomUUID(), base: record, draft, initial: draft };
}

function PublicationBadge({ record, dirty }) {
  const t = useUiText();
  const pending = record?.published && JSON.stringify(record.draft) !== JSON.stringify(record.published);
  return <div className="flex flex-wrap items-center gap-2">
    <Badge variant={record?.published_revision ? "secondary" : "outline"}>{record?.published_revision ? `${t("Published")} · v${record.published_revision}` : t("Draft")}</Badge>
    {(dirty || pending) && <span className="text-xs text-muted-foreground">{t(dirty ? "Unsaved changes" : "Unpublished changes")}</span>}
  </div>;
}

function ResourceCard({ record, draft, selected, dirty, disabled, onSelect, onArchive, coverageThreshold }) {
  const t = useUiText();
  const d = draft.definition;
  const name = draft.name || t(draft.kind === "schedule" ? "New schedule" : "New calendar");
  return <div className={cn("min-w-0 rounded-xl border transition-colors hover:border-foreground/30", selected && "border-telnyx-green bg-telnyx-green/5 ring-1 ring-telnyx-green/20")}>
    <button type="button" disabled={disabled} aria-label={t("Configure {value0}", { value0: name })} aria-pressed={selected} aria-controls="schedules-editor" onClick={onSelect}
      className="w-full rounded-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait">
      <div className="flex items-start gap-3">
        <div className="rounded-lg border bg-background p-2"><IconCalendarClock className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3"><span className="break-words font-semibold">{name}</span>{selected && <IconCheck className="size-5 shrink-0 text-telnyx-green" />}</div>
          <p className="mt-1 break-words text-sm text-muted-foreground">{draft.description || t("Select to edit in the configuration panel.")}</p>
          <div className="mt-3 space-y-2">
            {draft.kind === "schedule" ? <><Badge variant="outline">{d.timeZone}</Badge><p className="text-xs text-muted-foreground">{d.weekly.filter(day => day.periods.length).length} {t("open days per week")}</p></> : <><p className="text-xs text-muted-foreground">{d.coverageStart} – {d.coverageEnd}</p><div className="flex flex-wrap gap-2"><Badge variant="outline">{d.entries.length} {t("exceptions")}</Badge>{d.coverageEnd < coverageThreshold && <Badge variant="outline">{t("Review coverage")}</Badge>}</div></>}
            <PublicationBadge record={record} dirty={dirty} />
          </div>
        </div>
      </div>
    </button>
    {onArchive && <div className="flex justify-end px-3 pb-2"><Button variant="ghost" size="sm" disabled={disabled} aria-label={t("Archive") + " " + name} onClick={onArchive}><IconTrash className="mr-1 size-3.5" />{t("Archive")}</Button></div>}
  </div>;
}

function DraftOverview({ draft }) {
  const t = useUiText(), d = draft.definition;
  return <Card className="border bg-card shadow-sm"><CardHeader>
    <CardTitle>{t(draft.kind === "schedule" ? "Weekly overview" : "Calendar overview")}</CardTitle>
    <p className="text-sm text-muted-foreground">{t("This preview follows the properties you are editing. Save the draft, then publish to apply it to new calls.")}</p>
  </CardHeader><CardContent>
    {draft.kind === "schedule" ? <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">{d.weekly.map(day => <div key={day.day} className="min-w-0 rounded-lg bg-muted/40 px-3 py-3 text-sm"><span className="text-muted-foreground">{t(WEEKDAYS[day.day - 1])}</span><div className="mt-1 font-medium">{day.periods.length ? day.periods.map((period, i) => <div key={i}>{period.start} – {period.end}{period.end < period.start && <span className="ml-1 text-xs text-muted-foreground">(+1 {t("day")})</span>}</div>) : t("Closed")}</div></div>)}</div> : <div className="space-y-3">
      <div className="rounded-lg bg-muted/40 px-3 py-3 text-sm"><span className="text-muted-foreground">{t("Verified coverage")}</span><div className="font-medium">{d.coverageStart} – {d.coverageEnd}</div></div>
      {!d.entries.length ? <p className="text-sm text-muted-foreground">{t("No date exceptions. Weekly hours apply throughout the covered dates.")}</p> : <div className="grid gap-2 sm:grid-cols-2">{d.entries.map(entry => <div key={entry.id} className="min-w-0 rounded-lg bg-muted/40 px-3 py-3 text-sm"><div className="break-words font-medium">{entry.name || t("New exception")}</div><div className="mt-1 text-xs text-muted-foreground">{entry.startDate}{entry.endDate !== entry.startDate && ` – ${entry.endDate}`}{entry.repeat === "annual" && ` · ${t("Every year")}`}</div><div className="mt-1 text-xs">{t(entry.availability === "closed" ? "Closed all day" : entry.availability === "open" ? "Open 24 hours" : "Custom hours")}{entry.availability === "hours" && ` · ${entry.periods.map(p => `${p.start}–${p.end}`).join(", ")}`}</div></div>)}</div>}
    </div>}
  </CardContent></Card>;
}

export default function SchedulesPage() {
  const t = useUiText(), { can } = useAuth(), editorRef = useRef(null);
  const [items, setItems] = useState([]), [loading, setLoading] = useState(true), [loadError, setLoadError] = useState("");
  const [kind, setKind] = useState("schedule"), [search, setSearch] = useState("");
  const [editor, setEditor] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState(null), [publish, setPublish] = useState(false);
  const [references, setReferences] = useState(null), [referenceError, setReferenceError] = useState("");
  const [archiving, setArchiving] = useState(null), [archiveError, setArchiveError] = useState("");
  const [coverageThreshold] = useState(() => new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10));
  const draft = editor?.draft, base = editor?.base;
  const dirty = Boolean(editor && JSON.stringify(draft) !== JSON.stringify(base?.draft || editor.initial));
  const editable = editor && (base ? can("schedules:update") : can("schedules:create"));
  let validation = "";
  if (draft) { try { normalizeResource(draft); } catch (e) { validation = e.message; } }

  useEffect(() => {
    const abort = new AbortController();
    schedulesApi("", { signal: abort.signal }).then(data => { if (!abort.signal.aborted) setItems(data.items); })
      .catch(e => { if (!abort.signal.aborted) setLoadError(e.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const prevent = e => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);

  function navigate(action) {
    if (busy) return;
    if (dirty) setPendingAction({ run: action }); else action();
  }
  function select(record = null) {
    setEditor(editorFor(record?.kind || kind, record)); setError("");
    window.requestAnimationFrame(() => {
      editorRef.current?.scrollTo({ top: 0 });
      if (window.matchMedia("(max-width: 1279px)").matches) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  function update(patch) { setEditor(current => ({ ...current, draft: { ...current.draft, ...patch } })); }
  function updateDefinition(definition) { update({ definition }); }
  function remember(record) {
    setItems(current => [...current.filter(item => item.id !== record.id), record].sort((a, b) => a.draft.name.localeCompare(b.draft.name)));
    setEditor(current => ({ ...current, base: record, draft: record.draft }));
  }
  async function refresh() {
    setEditor(null); setLoading(true); setLoadError("");
    try { const data = await schedulesApi(); setItems(data.items); }
    catch (e) { setLoadError(e.message); } finally { setLoading(false); }
  }
  async function save() {
    setBusy(true); setError("");
    try {
      const data = await schedulesApi(base ? `/${base.id}` : "", { method: base ? "PUT" : "POST", body: JSON.stringify({ ...draft, editVersion: base?.edit_version }) });
      remember({ ...base, ...data.item });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function preparePublish() {
    setPublish(true); setReferences(null); setReferenceError("");
    try {
      const data = await schedulesApi(`/${base.id}`);
      if (data.item.edit_version !== base.edit_version) throw new Error("This resource changed. Reload before saving or publishing.");
      setReferences(data.affectedFlows);
    } catch (e) { setReferenceError(e.message); }
  }
  async function doPublish() {
    setBusy(true);
    try {
      const { publication } = await schedulesApi(`/${base.id}/publish`, { method: "POST", body: JSON.stringify({ editVersion: base.edit_version }) });
      remember({ ...base, edit_version: base.edit_version + 1, published_revision: publication.revision, published: publication.document, published_at: publication.published_at });
      setPublish(false);
      notify({ title: "Published", description: "New calls will use the published revision.", variant: "success" });
    } catch (e) { setReferenceError(e.message); } finally { setBusy(false); }
  }
  async function archive() {
    setBusy(true); setArchiveError("");
    try {
      await schedulesApi(`/${archiving.id}`, { method: "DELETE", body: JSON.stringify({ editVersion: archiving.edit_version }) });
      setItems(current => current.filter(item => item.id !== archiving.id));
      if (base?.id === archiving.id) setEditor(null);
      setArchiving(null);
    } catch (e) { setArchiveError(e.message); } finally { setBusy(false); }
  }

  const filtered = items.filter(item => item.kind === kind && (item.draft?.name || item.published?.name || "").toLowerCase().includes(search.toLowerCase()));
  const newDraft = editor && !base;
  return <AdminPageShell>
    <AdminPageHeader title={t("Schedules & calendars")} icon={IconCalendarClock}
      badges={loading ? <Skeleton className="h-6 w-16" /> : !loadError ? <Badge variant="secondary">{items.length}</Badge> : null}
      actions={<>
        <Button variant="outline" size="icon" aria-label={t("Refresh")} disabled={loading || busy} onClick={() => navigate(refresh)}><IconRefresh className="size-4" /></Button>
        <Can permission="schedules:create"><Button variant="outline" disabled={loading || busy || Boolean(loadError)} onClick={() => navigate(() => select())}><IconPlus className="mr-2 size-4" />{t(kind === "schedule" ? "New schedule" : "New calendar")}</Button></Can>
        {editor && <>{editable && <Button variant="outline" disabled={busy || Boolean(validation) || Boolean(base && !dirty)} onClick={save}>{t(busy ? "Saving..." : "Save draft")}</Button>}<Can permission="schedules:publish"><Button disabled={busy || !base || dirty || Boolean(validation)} onClick={preparePublish}>{t("Publish")}</Button></Can></>}
      </>}
    />
    <SystemSectionPage activeId="schedules">
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto pb-5 pr-1 xl:grid-cols-[minmax(0,1fr)_380px] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
        <section aria-label={t("Schedules overview")} className="min-w-0 space-y-4 xl:overflow-y-auto xl:p-1">
          <Card className="border bg-card shadow-sm"><CardHeader>
            <CardTitle>{t("Shared schedules and calendars")}</CardTitle>
            <p className="text-sm text-muted-foreground">{t("Select a card to edit its properties in the configuration panel.")}</p>
          </CardHeader><CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><Tabs value={kind} onValueChange={value => navigate(() => { setKind(value); setEditor(null); setSearch(""); setError(""); })}><TabsList><TabsTrigger value="schedule" disabled={busy}>{t("Schedules")}</TabsTrigger><TabsTrigger value="calendar" disabled={busy}>{t("Exception calendars")}</TabsTrigger></TabsList></Tabs><Input className="max-w-sm" aria-label={t("Filter by name")} placeholder={t("Filter by name...")} value={search} onChange={e => setSearch(e.target.value)} /></div>
            {loading ? <div role="status" aria-label={t("Loading schedules")} className="grid gap-3 2xl:grid-cols-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-40 w-full" />)}</div> : loadError ? <Alert variant="destructive"><AlertDescription>{t(loadError)}<Button variant="outline" size="sm" onClick={refresh}>{t("Retry")}</Button></AlertDescription></Alert> : <>
              {!filtered.length && !newDraft ? <div className="py-12 text-center text-muted-foreground"><IconCalendarClock className="mx-auto mb-3 size-10" /><p>{t(search ? "No matching schedules or calendars." : kind === "schedule" ? "No shared schedules yet." : "No exception calendars yet.")}</p></div> : <div className="grid gap-3 2xl:grid-cols-2">
                {newDraft && <ResourceCard draft={draft} selected dirty={dirty} disabled={busy} coverageThreshold={coverageThreshold} onSelect={() => {}} />}
                {filtered.map(item => <ResourceCard key={item.id} record={item} draft={base?.id === item.id ? draft : item.draft || item.published} selected={base?.id === item.id} dirty={base?.id === item.id && dirty} disabled={busy} coverageThreshold={coverageThreshold}
                  onSelect={() => { if (base?.id !== item.id) navigate(() => select(item)); }}
                  onArchive={can("schedules:delete") ? () => navigate(() => { if (dirty) setEditor(null); setArchiving(item); setArchiveError(""); }) : undefined} />)}
              </div>}
            </>}
            <p className="text-xs text-muted-foreground">{t("Schedules and calendars are shared across this Contact Center. Add a Schedules node in")} <Link className="underline" href="/admin/call-flows">{t("Call & App Flows")}</Link>.</p>
          </CardContent></Card>
          {editor && <DraftOverview draft={draft} />}
        </section>
        <aside id="schedules-editor" ref={editorRef} aria-label={t("Schedule configuration")} className="min-w-0 xl:min-h-0 xl:overflow-y-auto xl:p-1">
          <Card className="border bg-card shadow-sm">
            {loading ? <><CardHeader><Skeleton className="h-5 w-40" /></CardHeader><CardContent role="status" aria-label={t("Loading schedule properties")} className="space-y-5">{[0, 1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)}</CardContent></> : editor ? <>
              <CardHeader className="pb-4"><div className="flex items-start justify-between gap-2"><CardTitle className="text-base">{t(draft.kind === "schedule" ? "Configure shared schedule" : "Configure exception calendar")}</CardTitle><Button variant="ghost" size="icon" className="-mr-2 -mt-2 shrink-0" disabled={busy} aria-label={t("Close configuration")} onClick={() => navigate(() => setEditor(null))}><IconX className="size-4" /></Button></div>
                <p className="text-xs text-muted-foreground">{t("Use Save draft in the page header, then publish when the changes are ready for new calls.")}</p>
                <div role="status">{dirty ? <Badge variant="outline">{t("Unsaved changes")}</Badge> : base ? <Badge variant="secondary">{t("Draft saved")}</Badge> : <Badge variant="outline">{t("New draft")}</Badge>}</div>
              </CardHeader>
              <CardContent key={editor.key} className="@container space-y-5">
                <Label className="block space-y-1.5 text-xs"><span>{t("Name")}</span><Input value={draft.name} disabled={!editable || busy} maxLength={120} onChange={e => update({ name: e.target.value })} /></Label>
                <Label className="block space-y-1.5 text-xs"><span>{t("Description")}</span><Textarea value={draft.description} disabled={!editable || busy} maxLength={1000} onChange={e => update({ description: e.target.value })} /></Label>
                {draft.kind === "schedule" ? <><TimeZoneField value={draft.definition.timeZone} disabled={!editable || busy} onChange={timeZone => updateDefinition({ ...draft.definition, timeZone })} /><WeeklyHoursEditor value={draft.definition.weekly} disabled={!editable || busy} onChange={weekly => updateDefinition({ ...draft.definition, weekly })} />{can("schedules:test") && <ScheduleTester config={{ ...defaultScheduleConfig(), ...draft.definition }} disabled={Boolean(validation) || busy} />}</> : <ExceptionCalendarEditor value={draft.definition} onChange={updateDefinition} disabled={!editable || busy} />}
                {(error || validation) && <Alert variant={error ? "destructive" : "warning"}><AlertDescription>{t(error || validation)}</AlertDescription></Alert>}
              </CardContent>
            </> : <><CardHeader><CardTitle className="text-base">{t("Configuration")}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">{t(loadError ? "Reload the resources to configure a schedule or calendar." : "Select a schedule or calendar, or create a new one to edit its properties here.")}</CardContent></>}
          </Card>
        </aside>
      </div>
    </SystemSectionPage>
    <Dialog open={Boolean(pendingAction)} onOpenChange={open => !open && setPendingAction(null)}><DialogContent><DialogHeader><DialogTitle>{t("Discard unsaved changes?")}</DialogTitle><DialogDescription>{t("Your saved draft and published revision will remain available.")}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setPendingAction(null)}>{t("Keep editing")}</Button><Button variant="destructive" onClick={() => { const action = pendingAction.run; setPendingAction(null); action(); }}>{t("Discard changes")}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={publish} onOpenChange={open => !busy && setPublish(open)}><DialogContent><DialogHeader><DialogTitle>{t("Publish schedule changes?")}</DialogTitle><DialogDescription>{t("New calls use this revision. Calls already in progress retain their existing revisions.")}</DialogDescription></DialogHeader>{references === null && !referenceError ? <Skeleton className="h-24 w-full" /> : referenceError ? <Alert variant="destructive"><AlertDescription>{t(referenceError)}</AlertDescription></Alert> : <div className="max-h-64 space-y-2 overflow-y-auto text-sm"><p>{references.length} {t("Call Flows using this resource")}</p>{references.map(f => <div key={f.id}>{f.name}</div>)}</div>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPublish(false)}>{t("Cancel")}</Button><Button disabled={busy || references === null || Boolean(referenceError)} onClick={doPublish}>{t(busy ? "Publishing..." : "Publish revision")}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(archiving)} onOpenChange={open => !open && !busy && setArchiving(null)}><DialogContent><DialogHeader><DialogTitle>{t("Archive resource?")}</DialogTitle><DialogDescription>{archiving?.draft?.name} · {t("Published history is retained. Resources referenced by Call Flows cannot be archived.")}</DialogDescription></DialogHeader>{archiveError && <Alert variant="destructive"><AlertDescription>{t(archiveError)}</AlertDescription></Alert>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setArchiving(null)}>{t("Cancel")}</Button><Button variant="destructive" disabled={busy} onClick={archive}>{t("Archive")}</Button></DialogFooter></DialogContent></Dialog>
  </AdminPageShell>;
}
