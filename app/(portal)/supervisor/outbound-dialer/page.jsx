"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAdjustmentsHorizontal, IconBrandWhatsapp, IconCalendar, IconChartBar, IconCheck, IconChevronDown, IconClockHour4, IconDatabase, IconDots, IconEye, IconFilter, IconForms, IconListDetails, IconLoader2, IconMail, IconPhoneCall, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconPlus, IconRefresh, IconReportAnalytics, IconRotateClockwise, IconSettings, IconShieldCheck, IconSparkles, IconTrash, IconUpload, IconUsers, IconWand, IconX,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { notify } from "@/components/ToastNotify";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import {
  SupervisorPageHeader,
  SupervisorPageShell,
  supervisorPurplePageShellClass,
} from "@/components/contact-center/SupervisorPageLayout";
import { CSV_FILTER_OPERATORS, applyCsvImportRules, normalizeCsvImportRules } from "@/lib/outbound-dialer/csv-import-rules";

const API = "/api/contact-center/outbound-dialer";
const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconChartBar, description: "Live dialer performance" },
  { id: "campaigns", label: "Campaigns", icon: IconPhoneCall, description: "Build and tune outreach" },
  { id: "contact-lists", label: "Contact Lists", icon: IconDatabase, description: "Import audiences and fields" },
  { id: "dnc", label: "DNC", icon: IconShieldCheck, description: "Suppression governance" },
  { id: "filters", label: "Filters", icon: IconFilter, description: "Contact-list eligibility rules" },
  { id: "time-sets", label: "Time Sets", icon: IconCalendar, description: "Dialable windows by timezone" },
  { id: "attempt-controls", label: "Attempt Controls", icon: IconAdjustmentsHorizontal, description: "Caps, cadence, compliance" },
  { id: "reports", label: "Reports", icon: IconReportAnalytics, description: "Outcomes and exports" },
  { id: "event-viewer", label: "Event Viewer", icon: IconListDetails, description: "Dialer timeline" },
  { id: "settings", label: "Settings", icon: IconSettings, description: "Workspace defaults" },
];
const toneClasses = { emerald: "from-emerald-500/18 to-teal-500/5 text-emerald-600 dark:text-emerald-300", blue: "from-sky-500/18 to-blue-500/5 text-sky-600 dark:text-sky-300", violet: "from-violet-500/18 to-fuchsia-500/5 text-violet-600 dark:text-violet-300", amber: "from-amber-500/20 to-orange-500/5 text-amber-600 dark:text-amber-300", rose: "from-rose-500/18 to-red-500/5 text-rose-600 dark:text-rose-300" };
const neutralActionClass = "bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";
const neutralCardHoverClass = "hover:border-foreground/25 hover:bg-muted/50";
const controlButtonBaseClass = "h-8 w-8 rounded-full border bg-background/80 p-0 shadow-sm transition";
const controlButtonClasses = {
  start: `${controlButtonBaseClass} border-emerald-500/35 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-300 dark:hover:text-emerald-200`,
  stop: `${controlButtonBaseClass} border-rose-500/35 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300 dark:hover:text-rose-200`,
  pause: `${controlButtonBaseClass} border-amber-500/40 text-amber-600 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200`,
  resume: `${controlButtonBaseClass} border-sky-500/40 text-sky-600 hover:bg-sky-500/10 hover:text-sky-700 dark:text-sky-300 dark:hover:text-sky-200`,
  recycle: `${controlButtonBaseClass} border-violet-500/35 text-violet-600 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-200`,
};
const liveBadgeClasses = {
  active: "border-emerald-500/45 bg-transparent text-emerald-700 dark:text-emerald-300",
  ringing: "border-sky-500/45 bg-transparent text-sky-700 dark:text-sky-300",
  answered: "border-violet-500/45 bg-transparent text-violet-700 dark:text-violet-300",
  hangups: "border-amber-500/45 bg-transparent text-amber-700 dark:text-amber-300",
  failed: "border-rose-500/45 bg-transparent text-rose-700 dark:text-rose-300",
};
const emptySchema = { channels: ["voice", "sms", "whatsapp"], campaignModes: ["preview", "progressive", "power", "predictive", "agentless_ai", "agentless_flow"], campaignStatuses: ["draft", "ready", "paused", "running", "completed"], handlerTypes: ["queue", "ai_assistant", "call_flow"], contactListStatuses: ["draft", "validating", "validated"], dncListStatuses: ["draft", "active", "paused"], contactFieldTypes: ["text", "boolean", "number", "date", "datetime", "enum", "select", "phone", "email", "url", "currency"], standardContactColumns: [] };
const CSV_CONTACT_MAPPING_GROUPS = [
  { group: "Number", icon: IconPhoneCall, labelClass: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300", iconClass: "text-emerald-600 dark:text-emerald-300", options: ["mobile", "landline", "work", "home", "daytime", "evening"] },
  { group: "Email", icon: IconMail, labelClass: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300", iconClass: "text-sky-600 dark:text-sky-300", options: ["work", "home"] },
  { group: "WhatsApp", icon: IconBrandWhatsapp, labelClass: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", iconClass: "text-emerald-600 dark:text-emerald-300", options: ["work", "home"] },
];
const CSV_CONTACT_MAPPING_PREFIXES = ["number:", "email:", "whatsapp:"];
const title = (value) => String(value || "").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
const statusClass = (status) => ["ready", "validated", "running", "completed"].includes(status) ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : ["draft", "validating"].includes(status) ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" : status === "paused" ? "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300" : "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
const defaultCampaign = () => ({ name: "New voice campaign", description: "", status: "draft", channel: "voice", mode: "preview", handler_type: "queue", handler_ref: "", contact_list_id: null, attached_form_id: null, pacing_config: { strategy: "per_available_agent", ratio: 1, supervisorApproval: true }, concurrency_config: { maxConcurrent: 10, maxLines: 10, perAgentLimit: 1 }, dialing_windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00", timezonePolicy: "contact" }], retry_policy: { maxAttempts: 4, delayBetweenAttemptsMinutes: 360, minDelayHours: 6, exhaustAfterDays: 7 }, amd_config: { enabled: true, humanConfidenceThreshold: 0.74, voicemailAction: "hangup" }, form_variable_mapping: [], metadata: {} });
const defaultList = () => ({ name: "New contact list", description: "", status: "draft", source_type: "csv", custom_field_schema: [], record_count: 0, valid_phone_count: 0, metadata: {} });
const defaultDncList = () => ({ name: "New DNC list", description: "", status: "draft", source_type: "csv", match_strategy: "phone", record_count: 0, metadata: {} });
const defaultFilter = () => ({ name: "New contact filter", description: "", status: "draft", contact_list_id: null, conditions: [], metadata: {} });
const defaultTimeSet = () => ({ name: "Business hours", description: "", status: "draft", timezone: "Europe/Warsaw", windows: ["mon", "tue", "wed", "thu", "fri"].map((day) => ({ day, enabled: true, start: "09:00", end: "17:00" })), metadata: { view: "detail" } });
const WEEKDAYS = [{ id: "mon", label: "Mon" }, { id: "tue", label: "Tue" }, { id: "wed", label: "Wed" }, { id: "thu", label: "Thu" }, { id: "fri", label: "Fri" }, { id: "sat", label: "Sat" }, { id: "sun", label: "Sun" }];
const api = async (url, options = {}) => { const res = await fetch(url, { cache: "no-store", ...options, headers: options.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) } }); const data = await res.json().catch(() => ({})); if (!res.ok) { const details = data.details ? ` (${typeof data.details === "string" ? data.details : JSON.stringify(data.details)})` : ""; throw new Error(data.error ? `${data.error}${details}` : `Request failed (${res.status})`); } return data; };

const isDashboardCampaign = (campaign) => campaign && !["draft", "design", "archived"].includes(String(campaign.status || "").toLowerCase());
const executionStateFor = (campaign) => {
  const status = String(campaign?.status || "draft").toLowerCase();
  const metadataState = campaign?.metadata?.execution_state || campaign?.metadata?.executionState;
  if (metadataState) return String(metadataState).toLowerCase();
  if (status === "running") return "running";
  if (status === "paused") return "paused";
  if (status === "completed") return "completed";
  if (["ready", "scheduled", "published", "active"].includes(status)) return "ready";
  return status || "not started";
};
const campaignContactProgress = (campaign, contactLists = []) => {
  const list = contactLists.find((l) => l.id === campaign?.contact_list_id);
  const metadata = campaign?.metadata || {};
  const total = Number(metadata.total_records ?? metadata.totalRecords ?? list?.record_count ?? list?.valid_phone_count ?? 0) || 0;
  const completed = Math.min(total, Number(metadata.completed_records ?? metadata.completedRecords ?? metadata.dialed_records ?? metadata.dialedRecords ?? metadata.attempted_records ?? metadata.attemptedRecords ?? 0) || 0);
  const remaining = Math.max(total - completed, 0);
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { total, completed, remaining, progress, source: total > 0 ? (metadata.total_records || metadata.totalRecords ? "campaign metadata" : "contact list records") : "no contact records yet" };
};
const campaignLiveMetrics = (campaign) => {
  const metrics = campaign?.metadata?.live_metrics || campaign?.metadata?.liveMetrics || campaign?.metadata?.metrics || {};
  return {
    active: Number(metrics.active_calls ?? metrics.activeCalls ?? metrics.active ?? 0) || 0,
    ringing: Number(metrics.ringing ?? 0) || 0,
    answered: Number(metrics.answered ?? 0) || 0,
    hangups: Number(metrics.hangups ?? metrics.hangup ?? metrics.completed ?? 0) || 0,
    failed: Number(metrics.failed ?? 0) || 0,
    machine: Number(metrics.machine ?? metrics.answering_machine ?? metrics.answeringMachine ?? 0) || 0,
    noAnswer: Number(metrics.no_answer ?? metrics.noAnswer ?? 0) || 0,
  };
};
const campaignTimeline = (campaign) => {
  const events = campaign?.metadata?.event_timeline || campaign?.metadata?.eventTimeline || campaign?.metadata?.events || [];
  return Array.isArray(events) ? events.slice(0, 5) : [];
};
const keepSelectedRecord = (items) => (currentId) => (currentId && items.some((item) => item.id === currentId) ? currentId : items[0]?.id || null);

export default function OutboundDialerPage() {
  const [active, setActive] = useState("dashboard");
  const [campaigns, setCampaigns] = useState([]); const [contactLists, setContactLists] = useState([]); const [dncLists, setDncLists] = useState([]); const [filters, setFilters] = useState([]); const [timeSets, setTimeSets] = useState([]); const [forms, setForms] = useState([]); const [handlerReferences, setHandlerReferences] = useState({ queue: [], call_flow: [], ai_assistant: [] }); const [schema, setSchema] = useState(emptySchema);
  const [selectedCampaignId, setSelectedCampaignId] = useState(null); const [selectedListId, setSelectedListId] = useState(null); const [selectedDncId, setSelectedDncId] = useState(null); const [selectedFilterId, setSelectedFilterId] = useState(null); const [selectedTimeSetId, setSelectedTimeSetId] = useState(null); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState(null);
  const [headerSaveAction, setHeaderSaveAction] = useState(null);
  const activeMeta = useMemo(() => NAV_ITEMS.find((item) => item.id === active) || NAV_ITEMS[0], [active]);
  const selectedCampaign = useMemo(() => campaigns.find((c) => c.id === selectedCampaignId) || campaigns[0] || null, [campaigns, selectedCampaignId]);
  const dashboardCampaigns = useMemo(() => campaigns.filter(isDashboardCampaign), [campaigns]);
  const selectedDashboardCampaign = useMemo(() => dashboardCampaigns.find((c) => c.id === selectedCampaignId) || dashboardCampaigns[0] || null, [dashboardCampaigns, selectedCampaignId]);
  const selectedList = useMemo(() => contactLists.find((l) => l.id === selectedListId) || contactLists[0] || null, [contactLists, selectedListId]);
  const selectedDncList = useMemo(() => dncLists.find((l) => l.id === selectedDncId) || dncLists[0] || null, [dncLists, selectedDncId]);
  const selectedFilter = useMemo(() => filters.find((f) => f.id === selectedFilterId) || filters[0] || null, [filters, selectedFilterId]);
  const selectedTimeSet = useMemo(() => timeSets.find((t) => t.id === selectedTimeSetId) || timeSets[0] || null, [timeSets, selectedTimeSetId]);
  const refresh = useCallback(async (toast = false) => { try { setLoading(true); setError(null); const data = await api(API); const nextCampaigns = data.campaigns || []; const nextContactLists = data.contactLists || []; const nextDncLists = data.dncLists || []; const nextFilters = data.filters || []; const nextTimeSets = data.timeSets || []; setCampaigns(nextCampaigns); setContactLists(nextContactLists); setDncLists(nextDncLists); setFilters(nextFilters); setTimeSets(nextTimeSets); setForms(data.forms || []); setHandlerReferences(data.handlerReferences || { queue: [], call_flow: [], ai_assistant: [] }); setSchema(data.schema || emptySchema); setSelectedCampaignId(keepSelectedRecord(nextCampaigns)); setSelectedListId(keepSelectedRecord(nextContactLists)); setSelectedDncId(keepSelectedRecord(nextDncLists)); setSelectedFilterId(keepSelectedRecord(nextFilters)); setSelectedTimeSetId(keepSelectedRecord(nextTimeSets)); if (toast) notify({ title: "Outbound dialer refreshed", variant: "success" }); } catch (err) { setError(err.message); notify({ title: "Failed to load outbound dialer", description: err.message, variant: "error" }); } finally { setLoading(false); } }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const saveCampaign = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/campaigns/${draft.id}` : `${API}/campaigns`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setCampaigns((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.campaign } : i) : [data.campaign, ...items]); setSelectedCampaignId(data.campaign.id); notify({ title: draft.id ? "Campaign saved" : "Campaign created", variant: "success" }); return data.campaign; } catch (err) { notify({ title: "Campaign save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const runCampaignAction = async (campaign, action) => { if (!campaign?.id) return; const nextStatus = action === "start" ? "running" : action === "stop" ? "ready" : action === "pause" ? "paused" : action === "resume" ? "running" : action === "recycle" ? "ready" : campaign.status; const nextMetadata = { ...(campaign.metadata || {}), execution_control: { ...((campaign.metadata || {}).execution_control || {}), lastAction: action, updatedAt: new Date().toISOString(), scaffoldOnly: true }, execution_state: action === "stop" ? "stopped" : action === "recycle" ? "recycled" : nextStatus }; if (action === "recycle") nextMetadata.recycleRequestedAt = new Date().toISOString(); setSaving(true); try { const data = await api(`${API}/campaigns/${campaign.id}`, { method: "PUT", body: JSON.stringify({ ...campaign, status: nextStatus, metadata: nextMetadata }) }); setCampaigns((items) => items.map((i) => i.id === campaign.id ? { ...i, ...data.campaign } : i)); setSelectedCampaignId(campaign.id); notify({ title: `Campaign ${action === "recycle" ? "recycled" : nextStatus}`, description: "Execution control state updated; dialer worker remains scaffolded.", variant: "success" }); } catch (err) { notify({ title: "Campaign control failed", description: err.message, variant: "error" }); } finally { setSaving(false); } };
  const saveList = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/contact-lists/${draft.id}` : `${API}/contact-lists`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setContactLists((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.contactList } : i) : [data.contactList, ...items]); setSelectedListId(data.contactList.id); notify({ title: draft.id ? "Contact list saved" : "Contact list created", variant: "success" }); return data.contactList; } catch (err) { notify({ title: "Contact list save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const saveDncList = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/dnc-lists/${draft.id}` : `${API}/dnc-lists`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setDncLists((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.dncList } : i) : [data.dncList, ...items]); setSelectedDncId(data.dncList.id); notify({ title: draft.id ? "DNC list saved" : "DNC list created", variant: "success" }); return data.dncList; } catch (err) { notify({ title: "DNC save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const saveFilter = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/filters/${draft.id}` : `${API}/filters`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setFilters((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.filter } : i) : [data.filter, ...items]); setSelectedFilterId(data.filter.id); notify({ title: draft.id ? "Filter saved" : "Filter created", variant: "success" }); return data.filter; } catch (err) { notify({ title: "Filter save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const saveTimeSet = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/time-sets/${draft.id}` : `${API}/time-sets`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setTimeSets((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.timeSet } : i) : [data.timeSet, ...items]); setSelectedTimeSetId(data.timeSet.id); notify({ title: draft.id ? "Time set saved" : "Time set created", variant: "success" }); return data.timeSet; } catch (err) { notify({ title: "Time set save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const archive = async (kind, item) => { if (!item?.id) return; setSaving(true); try { const path = kind === "campaign" ? "campaigns" : kind === "dnc" ? "dnc-lists" : kind === "filter" ? "filters" : kind === "time-set" ? "time-sets" : "contact-lists"; await api(`${API}/${path}/${item.id}`, { method: "DELETE" }); if (kind === "campaign") setCampaigns((xs) => xs.filter((x) => x.id !== item.id)); else if (kind === "dnc") setDncLists((xs) => xs.filter((x) => x.id !== item.id)); else if (kind === "filter") setFilters((xs) => xs.filter((x) => x.id !== item.id)); else if (kind === "time-set") setTimeSets((xs) => xs.filter((x) => x.id !== item.id)); else setContactLists((xs) => xs.filter((x) => x.id !== item.id)); notify({ title: `${kind === "campaign" ? "Campaign" : kind === "dnc" ? "DNC list" : kind === "filter" ? "Filter" : kind === "time-set" ? "Time set" : "Contact list"} archived`, variant: "success" }); } catch (err) { notify({ title: "Archive failed", description: err.message, variant: "error" }); } finally { setSaving(false); } };

  const headerAction = { campaigns: { label: "New campaign", create: () => { setActive("campaigns"); saveCampaign(defaultCampaign()); } }, "contact-lists": { label: "New contact list", create: () => { setActive("contact-lists"); saveList(defaultList()); } }, dnc: { label: "New DNC list", create: () => { setActive("dnc"); saveDncList(defaultDncList()); } }, filters: { label: "New filter", create: () => { setActive("filters"); saveFilter(defaultFilter()); } }, "time-sets": { label: "New time set", create: () => { setActive("time-sets"); saveTimeSet(defaultTimeSet()); } } }[active];
  const registerHeaderSaveAction = useCallback((action) => setHeaderSaveAction(action), []);
  const activeSaveAction = headerSaveAction?.section === active ? headerSaveAction : null;

  return <SupervisorPageShell className={supervisorPurplePageShellClass}>
    <SupervisorPageHeader
      title="Outbound Dialer"
      badges={<><Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">Phase 2 CRUD</Badge><Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300">Persisted</Badge></>}
      actions={headerAction ? <><Button variant="outline" size="sm" onClick={() => refresh(true)} disabled={loading}><IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>{activeSaveAction ? <Button size="sm" className={neutralActionClass} onClick={activeSaveAction.onSave} disabled={activeSaveAction.disabled}>{activeSaveAction.busy ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconCheck className="mr-2 h-4 w-4" />}{activeSaveAction.label}</Button> : null}<Button size="sm" className={neutralActionClass} onClick={headerAction.create} disabled={saving}><IconWand className="mr-2 h-4 w-4" />{headerAction.label}</Button></> : null}
    />
    <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr) 380px` }}>
      <SectionRail items={NAV_ITEMS} activeId={active} onSelect={setActive} ariaLabel="Outbound dialer sections" />
      <section className="min-h-0 overflow-hidden rounded-2xl border bg-card/95 shadow-sm backdrop-blur flex flex-col"><div className="h-16 shrink-0 border-b bg-card/95 px-5 flex items-center justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold">{activeMeta.label}</h2><p className="text-xs text-muted-foreground">{activeMeta.description}</p></div></div><div className="flex-1 min-h-0 overflow-y-auto p-5">{loading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={() => refresh()} /> : active === "dashboard" ? <DashboardView campaigns={campaigns} contactLists={contactLists} selectedCampaignId={selectedDashboardCampaign?.id} setSelectedCampaignId={setSelectedCampaignId} runCampaignAction={runCampaignAction} saving={saving} /> : active === "campaigns" ? <CampaignsView campaigns={campaigns} selectedCampaign={selectedCampaign} setSelectedCampaignId={setSelectedCampaignId} archive={(item) => archive("campaign", item)} saving={saving} /> : active === "contact-lists" ? <ContactListsView contactLists={contactLists} selectedList={selectedList} setSelectedListId={setSelectedListId} archive={(item) => archive("list", item)} saving={saving} /> : active === "dnc" ? <DncListsView dncLists={dncLists} selectedDncList={selectedDncList} setSelectedDncId={setSelectedDncId} archive={(item) => archive("dnc", item)} saving={saving} /> : active === "filters" ? <FiltersView filters={filters} selectedFilter={selectedFilter} setSelectedFilterId={setSelectedFilterId} archive={(item) => archive("filter", item)} saving={saving} /> : active === "time-sets" ? <TimeSetsView timeSets={timeSets} selectedTimeSet={selectedTimeSet} setSelectedTimeSetId={setSelectedTimeSetId} archive={(item) => archive("time-set", item)} saving={saving} /> : <ComingSoonView item={activeMeta} />}</div></section>
      <aside className="min-h-0 overflow-hidden rounded-2xl border bg-card/92 shadow-sm backdrop-blur flex flex-col"><PanelHeader title={active === "dashboard" ? "Campaign monitor" : "Context settings"} description={active === "dashboard" ? "Execution status details" : `${activeMeta.label} configuration`} /><SettingsPanel active={active} campaign={active === "dashboard" ? selectedDashboardCampaign : selectedCampaign} contactList={selectedList} dncList={selectedDncList} filter={selectedFilter} timeSet={selectedTimeSet} forms={forms} contactLists={contactLists} dncLists={dncLists} filters={filters} timeSets={timeSets} handlerReferences={handlerReferences} schema={schema} saveCampaign={saveCampaign} saveList={saveList} saveDncList={saveDncList} saveFilter={saveFilter} saveTimeSet={saveTimeSet} saving={saving} onImported={refresh} registerHeaderSaveAction={registerHeaderSaveAction} /></aside>
    </main></SupervisorPageShell>;
}

function DashboardView({ campaigns, contactLists, selectedCampaignId, setSelectedCampaignId, runCampaignAction, saving }) {
  const visibleCampaigns = campaigns.filter(isDashboardCampaign);
  const callable = contactLists.reduce((sum, l) => sum + Number(l.valid_phone_count || 0), 0);
  const activeLiveCalls = visibleCampaigns.reduce((sum, c) => sum + campaignLiveMetrics(c).active, 0);
  const metrics = [
    { label: "Published campaigns", value: String(visibleCampaigns.length), delta: "draft/design excluded", icon: IconPlayerPlay, tone: "emerald" },
    { label: "Callable contacts", value: callable.toLocaleString(), delta: `${contactLists.length} persisted lists`, icon: IconUsers, tone: "blue" },
    { label: "Active calls", value: String(activeLiveCalls), delta: "metadata/event scaffold", icon: IconPhoneCall, tone: "violet" },
    { label: "Guardrail health", value: "Ready", delta: "worker not enabled yet", icon: IconShieldCheck, tone: "amber" },
  ];
  return <div className="space-y-5"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{metrics.map((m) => { const Icon = m.icon; return <div key={m.label} className="rounded-2xl border bg-background/80 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="flex items-center justify-between"><span className={`rounded-xl bg-gradient-to-br p-2.5 ${toneClasses[m.tone]}`}><Icon className="h-5 w-5" /></span><IconDots className="h-4 w-4 text-muted-foreground" /></div><div className="mt-4 text-2xl font-semibold tracking-tight">{m.value}</div><div className="text-sm text-muted-foreground">{m.label}</div><div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-300">{m.delta}</div></div>; })}</div><div className="rounded-2xl border bg-background/80 p-5 shadow-sm"><div><h3 className="font-semibold">Campaign command center</h3><p className="text-sm text-muted-foreground">Published outbound campaigns with execution controls and scaffolded live metrics.</p></div><div className="mt-4 space-y-3">{visibleCampaigns.length ? visibleCampaigns.map((c) => <DashboardCampaignCard key={c.id} campaign={c} contactLists={contactLists} selected={selectedCampaignId === c.id} onSelect={() => setSelectedCampaignId(c.id)} onAction={runCampaignAction} saving={saving} />) : <Empty title="No published campaigns" description="Draft and design campaigns stay in Campaigns. Set a campaign to Ready/Running/Paused/Completed to monitor it here." />}</div></div></div>;
}

function DashboardCampaignCard({ campaign, contactLists, selected, onSelect, onAction, saving }) {
  const progress = campaignContactProgress(campaign, contactLists);
  const live = campaignLiveMetrics(campaign);
  const state = executionStateFor(campaign);
  const isPaused = state === "paused";
  const pauseAction = isPaused ? "resume" : "pause";
  return <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(); }} className={`w-full rounded-xl border bg-card p-4 text-left transition ${selected ? "border-foreground/40 bg-muted/60 shadow-sm" : neutralCardHoverClass}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{campaign.name}</span><Badge variant="outline" className={statusClass(campaign.status)}>{title(state)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{title(campaign.mode)} · {title(campaign.channel)} · {campaign.contact_list_name || "No list attached"}</p></div><div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}><Button type="button" variant="ghost" size="icon" className={controlButtonClasses.start} disabled={saving} title="Start campaign" onClick={() => onAction(campaign, "start")}><IconPlayerPlay className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" className={controlButtonClasses.stop} disabled={saving} title="Stop campaign" onClick={() => onAction(campaign, "stop")}><IconPlayerStop className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" className={controlButtonClasses[pauseAction]} disabled={saving} title={isPaused ? "Resume campaign" : "Pause campaign"} onClick={() => onAction(campaign, pauseAction)}>{isPaused ? <IconPlayerPlay className="h-4 w-4" /> : <IconPlayerPause className="h-4 w-4" />}</Button><Button type="button" variant="ghost" size="icon" className={controlButtonClasses.recycle} disabled={saving} title="Recycle contact processing" onClick={() => onAction(campaign, "recycle")}><IconRotateClockwise className="h-4 w-4" /></Button></div></div><div className="mt-4 grid gap-2 text-xs sm:grid-cols-4"><MiniStat label="Total" value={progress.total.toLocaleString()} icon={IconDatabase} tone="blue" /><MiniStat label="Completed" value={progress.completed.toLocaleString()} icon={IconShieldCheck} tone="emerald" /><MiniStat label="Remaining" value={progress.remaining.toLocaleString()} icon={IconClockHour4} tone="amber" /><MiniStat label="Answered" value={live.answered.toLocaleString()} icon={IconPhoneCall} tone="violet" /></div><div className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span>{progress.progress}% processed</span><span>{progress.source}</span></div><Progress className="mt-2 h-2" value={progress.progress} /><div className="mt-3 flex flex-wrap gap-2 text-[11px]"><Badge variant="outline" className={`font-normal ${liveBadgeClasses.active}`}>Active {live.active}</Badge><Badge variant="outline" className={`font-normal ${liveBadgeClasses.ringing}`}>Ringing {live.ringing}</Badge><Badge variant="outline" className={`font-normal ${liveBadgeClasses.answered}`}>Answered {live.answered}</Badge><Badge variant="outline" className={`font-normal ${liveBadgeClasses.hangups}`}>Hangups {live.hangups}</Badge><Badge variant="outline" className={`font-normal ${liveBadgeClasses.failed}`}>Failed {live.failed}</Badge></div></div>;
}

function CampaignsView({ campaigns, selectedCampaign, setSelectedCampaignId, archive, saving }) {
  return <CrudTable
    title="Campaign inventory"
    description="Rows select configuration in the right Settings card; execution controls stay on Dashboard."
    emptyTitle="No campaigns yet"
    emptyDescription="Use New campaign in the workspace header to create the first persisted campaign."
    columns={["Name", "Status", "List", "Mode", "Ready", "Actions"]}
    rows={campaigns.map((c) => ({
      id: c.id,
      selected: selectedCampaign?.id === c.id,
      onSelect: () => setSelectedCampaignId(c.id),
      cells: [<span key="name" className="font-medium">{c.name}</span>, <Badge key="status" variant="outline" className={statusClass(c.status)}>{title(c.status)}</Badge>, c.contact_list_name || "—", title(c.mode), `${readiness(c)}%`],
      actions: <DeleteButton disabled={saving} onClick={() => archive(c)} label="Archive campaign" />,
    }))}
  />;
}

function ContactListsView({ contactLists, selectedList, setSelectedListId, archive, saving }) {
  return <CrudTable
    title="Contact list inventory"
    description="Import audiences and tune field schema from the right Settings card."
    emptyTitle="No contact lists yet"
    emptyDescription="Use New contact list in the workspace header, then upload or paste CSV data."
    columns={["Name", "Status", "Records", "Valid phones", "Fields", "Actions"]}
    rows={contactLists.map((l) => ({
      id: l.id,
      selected: selectedList?.id === l.id,
      onSelect: () => setSelectedListId(l.id),
      cells: [<span key="name" className="font-medium">{l.name}</span>, <Badge key="status" variant="outline" className={statusClass(l.status)}>{title(l.status)}</Badge>, Number(l.record_count || 0).toLocaleString(), Number(l.valid_phone_count || 0).toLocaleString(), (l.custom_field_schema || []).length],
      actions: <DeleteButton disabled={saving} onClick={() => archive(l)} label="Archive contact list" />,
    }))}
  />;
}

function DncListsView({ dncLists, selectedDncList, setSelectedDncId, archive, saving }) {
  return <CrudTable
    title="DNC suppression lists"
    description="Persisted suppression list metadata and CSV-ready governance scaffold."
    emptyTitle="No DNC lists yet"
    emptyDescription="Use New DNC list in the workspace header to create a persisted suppression source."
    columns={["Name", "Status", "Source", "Match", "Records", "Actions"]}
    rows={dncLists.map((l) => ({
      id: l.id,
      selected: selectedDncList?.id === l.id,
      onSelect: () => setSelectedDncId(l.id),
      cells: [<span key="name" className="font-medium">{l.name}</span>, <Badge key="status" variant="outline" className={statusClass(l.status)}>{title(l.status)}</Badge>, title(l.source_type || "csv"), title(l.match_strategy || "phone"), Number(l.record_count || 0).toLocaleString()],
      actions: <DeleteButton disabled={saving} onClick={() => archive(l)} label="Archive DNC list" />,
    }))}
  />;
}


function FiltersView({ filters, selectedFilter, setSelectedFilterId, archive, saving }) {
  return <CrudTable
    title="Contact-list filters"
    description="Define eligibility rules applied when a campaign starts or recycles. Execution is scaffolded for the future dialer worker."
    emptyTitle="No filters yet"
    emptyDescription="Use New filter to persist reusable contact-list filtering metadata."
    columns={["Name", "Status", "Contact list", "Rules", "Actions"]}
    rows={filters.map((f) => ({
      id: f.id,
      selected: selectedFilter?.id === f.id,
      onSelect: () => setSelectedFilterId(f.id),
      cells: [<span key="name" className="font-medium">{f.name}</span>, <Badge key="status" variant="outline" className={statusClass(f.status)}>{title(f.status)}</Badge>, f.contact_list_name || "Any list", `${(f.conditions || []).length} rule${(f.conditions || []).length === 1 ? "" : "s"}`],
      actions: <DeleteButton disabled={saving} onClick={() => archive(f)} label="Archive filter" />,
    }))}
  />;
}

function TimeSetsView({ timeSets, selectedTimeSet, setSelectedTimeSetId, archive, saving }) {
  return <CrudTable
    title="Contactable time sets"
    description="Reusable weekly dialing windows. Campaign enforcement is not enabled yet."
    emptyTitle="No time sets yet"
    emptyDescription="Use New time set to persist timezone-aware weekly windows."
    columns={["Name", "Status", "Time zone", "Windows", "Actions"]}
    rows={timeSets.map((t) => ({
      id: t.id,
      selected: selectedTimeSet?.id === t.id,
      onSelect: () => setSelectedTimeSetId(t.id),
      cells: [<span key="name" className="font-medium">{t.name}</span>, <Badge key="status" variant="outline" className={statusClass(t.status)}>{title(t.status)}</Badge>, t.timezone || "Europe/Warsaw", `${(t.windows || []).filter((w) => w.enabled !== false).length} active`],
      actions: <DeleteButton disabled={saving} onClick={() => archive(t)} label="Archive time set" />,
    }))}
  />;
}

function CrudTable({ title: tableTitle, description, columns, rows, emptyTitle, emptyDescription }) {
  return <div className="rounded-2xl border bg-background/85 p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">{tableTitle}</h3><p className="text-sm text-muted-foreground">{description}</p></div><Badge variant="outline" className="bg-card">{rows.length} total</Badge></div>{rows.length ? <div className="mt-5 overflow-hidden rounded-xl border"><div className="grid bg-muted/45 px-3 py-2 text-xs font-semibold text-muted-foreground" style={{ gridTemplateColumns: `repeat(${columns.length - 1}, minmax(0, 1fr)) 76px` }}>{columns.map((c) => <span key={c} className={c === "Actions" ? "text-right" : ""}>{c}</span>)}</div>{rows.map((row) => <div key={row.id} role="button" tabIndex={0} onClick={row.onSelect} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") row.onSelect(); }} className={`grid items-center gap-3 border-t px-3 py-3 text-sm transition ${row.selected ? "bg-muted/70" : "bg-background/70 hover:bg-muted/40"}`} style={{ gridTemplateColumns: `repeat(${columns.length - 1}, minmax(0, 1fr)) 76px` }}>{row.cells.map((cell, idx) => <div key={idx} className="min-w-0 truncate">{cell}</div>)}<div className="flex justify-end" onClick={(e) => e.stopPropagation()}>{row.actions}</div></div>)}</div> : <div className="mt-5"><Empty title={emptyTitle} description={emptyDescription} /></div>}</div>;
}

function DeleteButton({ onClick, disabled, label }) {
  return <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600" disabled={disabled} onClick={onClick} title={label}><IconTrash className="h-4 w-4" /></Button>;
}

function SettingsPanel({ active, campaign, contactList, dncList, filter, timeSet, forms, contactLists, dncLists, filters, timeSets, handlerReferences, schema, saveCampaign, saveList, saveDncList, saveFilter, saveTimeSet, saving, onImported, registerHeaderSaveAction }) {
  if (active === "dashboard") return <DashboardMonitorPanel campaign={campaign} contactLists={contactLists} />;
  if (active === "campaigns") return <CampaignSettingsForm campaign={campaign} forms={forms} contactLists={contactLists} dncLists={dncLists} filters={filters} timeSets={timeSets} handlerReferences={handlerReferences} schema={schema} saveCampaign={saveCampaign} saving={saving} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "contact-lists") return <ContactListSettingsForm contactList={contactList} schema={schema} saveList={saveList} saving={saving} onImported={onImported} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "dnc") return <DncSettingsForm dncList={dncList} schema={schema} saveDncList={saveDncList} saving={saving} onImported={onImported} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "filters") return <FilterSettingsForm filter={filter} contactLists={contactLists} schema={schema} saveFilter={saveFilter} saving={saving} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "time-sets") return <TimeSetSettingsForm timeSet={timeSet} saveTimeSet={saveTimeSet} saving={saving} registerHeaderSaveAction={registerHeaderSaveAction} />;
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconSparkles} title="Workspace defaults" subtitle="Phase 2 foundation"><ConfigSelect label="Default channel" value="voice" options={schema.channels} /><ConfigSelect label="Default mode" value="preview" options={schema.campaignModes} /><ToggleRow label="Show launch readiness checks" checked /><ToggleRow label="Emit future worker events" checked /></SettingCard><div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Settings are persisted for campaigns/lists/DNC only. No worker, scheduler, or dialer execution was added.</div></div>;
}

function CampaignSettingsForm({ campaign, forms, contactLists, dncLists, filters, timeSets, handlerReferences, schema, saveCampaign, saving, registerHeaderSaveAction }) {
  const [draft, setDraft] = useState(campaign || defaultCampaign());
  useEffect(() => setDraft(campaign || defaultCampaign()), [campaign]);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const updateJson = (key, patch) => setDraft((d) => ({ ...d, [key]: { ...(d[key] || {}), ...patch } }));
  const updateMetadata = (patch) => updateJson("metadata", patch);
  const selectedList = contactLists.find((l) => l.id === draft.contact_list_id);
  const phoneFields = contactListNumberOptions(selectedList, schema);
  const handlerOptions = handlerReferences?.[draft.handler_type] || [];
  const mode = draft.mode || "preview";
  const showPacing = ["power", "predictive"].includes(mode);
  const maxLines = draft.concurrency_config?.maxLines ?? draft.concurrency_config?.maxConcurrent ?? 10;
  const delayMinutes = draft.retry_policy?.delayBetweenAttemptsMinutes ?? (((Number(draft.retry_policy?.minDelayHours) || 0) * 60) || 360);
  const selectedNumberFields = draft.metadata?.contact_list_numbers || [];
  const campaignModes = [...(schema.campaignModes || [])].sort((a, b) => (["agentless_ai", "agentless_flow"].includes(a) ? 1 : 0) - (["agentless_ai", "agentless_flow"].includes(b) ? 1 : 0));
  const channelOptions = (schema.channels || ["voice", "sms", "whatsapp"]).map((channel) => ({ value: channel, label: channel === "voice" ? "Voice" : `${title(channel)} — not available yet`, disabled: channel !== "voice" }));
  useEffect(() => { registerHeaderSaveAction({ section: "campaigns", label: "Save campaign", disabled: saving || !draft.name?.trim(), busy: saving, onSave: () => saveCampaign(draft) }); return () => registerHeaderSaveAction(null); }, [draft, saving, saveCampaign, registerHeaderSaveAction]);
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
    <SettingCard icon={IconPhoneCall} title="Campaign Details" subtitle="Name, description, and launch state"><InputBlock label="Campaign Name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" rows={3} value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} /></div><div className="mt-3"><ConfigSelect label="Launch State" value={draft.status} options={schema.campaignStatuses} onChange={(v) => update({ status: v })} /></div></SettingCard>
    <SettingCard icon={IconAdjustmentsHorizontal} title="Dialing Strategy" subtitle="Voice execution settings; worker remains scaffolded"><div className="grid grid-cols-2 gap-3"><ConfigSelect label="Channel" value={draft.channel || "voice"} options={channelOptions} onChange={(v) => update({ channel: v })} /><ConfigSelect label="Mode" value={mode} options={campaignModes} onChange={(v) => update({ mode: v })} /><ConfigSelect label="Handler" value={draft.handler_type || "queue"} options={schema.handlerTypes} onChange={(v) => update({ handler_type: v, handler_ref: "" })} /><ConfigSelect label="Reference" value={draft.handler_ref || "none"} options={[{ value: "none", label: handlerOptions.length ? "Select reference" : `No ${title(draft.handler_type)} references loaded` }, ...handlerOptions.map((ref) => ({ value: ref.id, label: ref.name }))]} onChange={(v) => update({ handler_ref: v === "none" ? "" : v })} /><InputBlock label="Max Lines" type="number" value={maxLines} onChange={(v) => updateJson("concurrency_config", { maxLines: Number(v) || 0, maxConcurrent: Number(v) || 0 })} />{showPacing ? <InputBlock label="Pacing Ratio" type="number" value={draft.pacing_config?.ratio || 1} onChange={(v) => updateJson("pacing_config", { ratio: Number(v) || 1 })} /> : null}<InputBlock label="Max attempts" type="number" value={draft.retry_policy?.maxAttempts || 4} onChange={(v) => updateJson("retry_policy", { maxAttempts: Number(v) || 0 })} /><InputBlock label="Attempts delay (min)" type="number" value={delayMinutes} onChange={(v) => updateJson("retry_policy", { delayBetweenAttemptsMinutes: Number(v) || 0, minDelayHours: Math.round((Number(v) || 0) / 60) })} /></div><div className="mt-3"><ToggleRow label="Answering Machine Detection" checked={draft.amd_config?.enabled !== false} onCheckedChange={(v) => updateJson("amd_config", { enabled: v })} /></div></SettingCard>
    <SettingCard icon={IconForms} title="Campaign Options" subtitle="Audience, scripts, suppression, filters, and contactable windows"><div className="grid gap-3"><ConfigSelect label="Contact List" value={draft.contact_list_id || "none"} options={[{ value: "none", label: "Not attached" }, ...contactLists.map((l) => ({ value: l.id, label: l.name }))]} onChange={(v) => update({ contact_list_id: v === "none" ? null : v })} /><MultiSelect label="Contact List Numbers" values={selectedNumberFields} options={phoneFields} emptyLabel="Attach a contact list with phone fields to choose callable numbers." onChange={(values) => updateMetadata({ contact_list_numbers: values })} /><ConfigSelect label="Agent Script" value={draft.attached_form_id || "none"} options={[{ value: "none", label: "Not attached" }, ...forms.map((f) => ({ value: f.id, label: f.name }))]} onChange={(v) => update({ attached_form_id: v === "none" ? null : v })} /><ConfigSelect label="DNC List" value={draft.metadata?.dnc_list_id || "none"} options={[{ value: "none", label: "No DNC list" }, ...dncLists.map((l) => ({ value: l.id, label: l.name }))]} onChange={(v) => updateMetadata({ dnc_list_id: v === "none" ? null : v })} /><ConfigSelect label="Contact List Filter" value={draft.metadata?.contact_list_filter_id || "none"} options={[{ value: "none", label: "No filter" }, ...filters.map((f) => ({ value: f.id, label: f.name }))]} onChange={(v) => updateMetadata({ contact_list_filter_id: v === "none" ? null : v })} /><ConfigSelect label="Contactable Time Set" value={draft.metadata?.contactable_time_set_id || "none"} options={[{ value: "none", label: "No time set" }, ...timeSets.map((t) => ({ value: t.id, label: `${t.name} · ${t.timezone || "timezone"}` }))]} onChange={(v) => updateMetadata({ contactable_time_set_id: v === "none" ? null : v })} /></div></SettingCard>
    <MappingEditor campaign={draft} contactLists={contactLists} update={update} />
  </div>;
}

function ContactListSettingsForm({ contactList, schema, saveList, saving, onImported, registerHeaderSaveAction }) {
  const [draft, setDraft] = useState(contactList || defaultList());
  const [csv, setCsv] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [csvImportConfig, setCsvImportConfig] = useState({ selectedColumns: [], columnMappings: {} });
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    const next = contactList || defaultList();
    setDraft(next);
    setCsv("");
    setCsvFileName("");
    setCsvImportConfig(normalizeCsvImportConfig(next.metadata?.csv_import_settings));
  }, [contactList]);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const csvPreview = useMemo(() => parseCsvPreview(csv, 10), [csv]);
  useEffect(() => {
    if (!csvPreview.headers.length) return;
    setCsvImportConfig((config) => {
      const retainedColumns = config.selectedColumns?.length ? config.selectedColumns.filter((column) => csvPreview.headers.includes(column)) : csvPreview.headers;
      return { ...config, selectedColumns: retainedColumns.length ? retainedColumns : csvPreview.headers, columnMappings: Object.fromEntries(Object.entries(config.columnMappings || {}).filter(([column]) => csvPreview.headers.includes(column))), noDuplicateColumns: (config.noDuplicateColumns || []).filter((column) => csvPreview.headers.includes(column)), columnFilters: Object.fromEntries(Object.entries(config.columnFilters || {}).filter(([column]) => csvPreview.headers.includes(column))) };
    });
  }, [csvPreview.headersKey]);
  const selectedFieldSchema = useMemo(() => schemaForSelectedCsvColumns(csvPreview.headers, csvImportConfig, draft.custom_field_schema), [csvPreview.headers, csvImportConfig, draft.custom_field_schema]);
  const importMetadata = useMemo(() => buildCsvImportMetadata(csvPreview.headers, csvImportConfig, csvFileName), [csvPreview.headers, csvImportConfig, csvFileName]);
  const importReadiness = useMemo(() => getCsvImportReadiness(csv, csvPreview.headers, csvImportConfig), [csv, csvPreview.headers, csvImportConfig]);
  const updateSelectedFieldType = (fieldName, type) => update({ custom_field_schema: upsertFieldSchemaType(draft.custom_field_schema, fieldName, type) });
  const save = useCallback(() => saveList({ ...draft, custom_field_schema: selectedFieldSchema.length ? selectedFieldSchema : draft.custom_field_schema, metadata: { ...(draft.metadata || {}), ...(csvPreview.headers.length ? { csv_import_settings: importMetadata } : {}) } }), [draft, selectedFieldSchema, csvPreview.headers.length, importMetadata, saveList]);
  const importCsv = async () => { if (!csv.trim()) return notify({ title: "Choose a CSV first", description: "Select or drop a CSV file before importing.", variant: "warning" }); if (!importReadiness.ready) return notify({ title: "Preview mapping required", description: importReadiness.message, variant: "warning" }); setImporting(true); try { const savedList = await save(); if (!savedList?.id) return; const data = await api(`${API}/contact-lists/${savedList.id}/import`, { method: "POST", body: JSON.stringify({ csv, metadata: { ...importMetadata, field_schema: selectedFieldSchema } }) }); notify({ title: "CSV imported", description: `${data.totalRows} rows, ${data.validPhones} valid mapped phone/WhatsApp numbers`, variant: "success" }); await onImported(); } catch (err) { notify({ title: "CSV import failed", description: err.message, variant: "error" }); } finally { setImporting(false); } };
  useEffect(() => { registerHeaderSaveAction({ section: "contact-lists", label: "Save contact list", disabled: saving || !draft.name?.trim(), busy: saving, onSave: save }); return () => registerHeaderSaveAction(null); }, [draft, saving, save, registerHeaderSaveAction]);
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconDatabase} title={draft.id ? draft.name : "Contact list configuration"} subtitle="Persisted list details"><InputBlock label="List name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} rows={2} /></div><div className="mt-3"><ConfigSelect label="Status" value={draft.status} options={schema.contactListStatuses} onChange={(v) => update({ status: v })} /></div></SettingCard><CsvUploadCard title="CSV upload" description="Choose a CSV, preview the first 10 records, select import columns, and map at least one contact method. Campaign-specific validation will later require Number/WhatsApp for voice/WhatsApp and Email for email campaigns." csv={csv} setCsv={setCsv} fileName={csvFileName} setFileName={setCsvFileName} preview={csvPreview} importConfig={csvImportConfig} setImportConfig={setCsvImportConfig} onImport={importCsv} importing={importing} disabled={!draft.id} buttonLabel="Upload" readiness={importReadiness} importedPreviewEndpoint={draft.id ? `${API}/contact-lists/${draft.id}/preview` : null} hasImportedPreview={Number(draft.record_count || 0) > 0} importedPreviewTitle="Imported contact list preview" importedPreviewDescription="Read-only preview of up to 10 records imported into the database." /><SettingCard icon={IconForms} title="Field schema" subtitle="Fields come from selected CSV import columns and are stored/searchable in contact record JSONB.">{selectedFieldSchema.length ? <div className="grid gap-2">{selectedFieldSchema.map((field) => <div key={field.name} className="grid grid-cols-[minmax(0,1fr)_140px] items-center gap-2 rounded-lg border bg-background/70 p-2"><div className="min-w-0"><div className="truncate font-mono text-xs">{field.name}</div><div className="text-[11px] text-muted-foreground">Imported CSV column</div></div><ConfigSelect bare value={field.type || "text"} options={schema.contactFieldTypes} onChange={(v) => updateSelectedFieldType(field.name, v)} /></div>)}</div> : <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No import fields selected yet. Choose a CSV, open the preview, and select columns to populate this schema.</div>}</SettingCard></div>;
}

function DncSettingsForm({ dncList, schema, saveDncList, saving, onImported, registerHeaderSaveAction }) {
  const [draft, setDraft] = useState(dncList || defaultDncList());
  const [csv, setCsv] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [csvImportConfig, setCsvImportConfig] = useState(() => normalizeCsvImportConfig(dncList?.metadata?.csv_import_settings));
  const [importing, setImporting] = useState(false);
  useEffect(() => { setDraft(dncList || defaultDncList()); setCsvImportConfig(normalizeCsvImportConfig(dncList?.metadata?.csv_import_settings)); setCsv(""); setCsvFileName(""); }, [dncList]);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const csvPreview = useMemo(() => parseCsvPreview(csv, 10), [csv]);
  const dncColumnStats = useMemo(() => classifyDncPreviewColumns(csvPreview.records, csvPreview.headers), [csvPreview.headersKey, csvPreview.records]);
  useEffect(() => {
    if (!csvPreview.headers.length) return;
    setCsvImportConfig((config) => {
      const allowedColumns = csvPreview.headers.filter((column) => dncColumnAllowed(dncColumnStats[column], draft.match_strategy || "phone"));
      const retainedColumns = config.selectedColumns?.length ? config.selectedColumns.filter((column) => allowedColumns.includes(column)) : allowedColumns;
      return { ...config, selectedColumns: retainedColumns, columnMappings: Object.fromEntries(Object.entries(config.columnMappings || {}).filter(([column]) => csvPreview.headers.includes(column))), noDuplicateColumns: (config.noDuplicateColumns || []).filter((column) => csvPreview.headers.includes(column)), columnFilters: Object.fromEntries(Object.entries(config.columnFilters || {}).filter(([column]) => csvPreview.headers.includes(column))) };
    });
  }, [csvPreview.headersKey, dncColumnStats, draft.match_strategy]);
  const importMetadata = useMemo(() => buildCsvImportMetadata(csvPreview.headers, csvImportConfig, csvFileName), [csvPreview.headers, csvImportConfig, csvFileName]);
  const importReadiness = useMemo(() => getDncCsvImportReadiness(csv, csvPreview.headers, csvImportConfig, draft.match_strategy, dncColumnStats), [csv, csvPreview.headers, csvImportConfig, draft.match_strategy, dncColumnStats]);
  const save = useCallback(() => saveDncList({ ...draft, source_type: draft.source_type || "csv", metadata: { ...(draft.metadata || {}), ...(csvPreview.headers.length ? { csv_import_settings: importMetadata } : {}) } }), [draft, csvPreview.headers.length, importMetadata, saveDncList]);
  const importCsv = async () => { if (!csv.trim()) return notify({ title: "Choose a CSV first", description: "Select or drop a CSV file before importing.", variant: "warning" }); if (!importReadiness.ready) return notify({ title: "Preview selection required", description: importReadiness.message, variant: "warning" }); setImporting(true); try { const savedDncList = await save(); if (!savedDncList?.id) return; const data = await api(`${API}/dnc-lists/${savedDncList.id}/import`, { method: "POST", body: JSON.stringify({ csv, metadata: importMetadata }) }); notify({ title: "DNC CSV imported", description: `${data.totalRows} suppression rows counted from selected columns`, variant: "success" }); await onImported(); } catch (err) { notify({ title: "DNC import failed", description: err.message, variant: "error" }); } finally { setImporting(false); } };
  useEffect(() => { registerHeaderSaveAction({ section: "dnc", label: "Save DNC list", disabled: saving || importing || !draft.name?.trim(), busy: saving || importing, onSave: save }); return () => registerHeaderSaveAction(null); }, [draft, saving, importing, save, registerHeaderSaveAction]);
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconShieldCheck} title={draft.id ? draft.name : "DNC list configuration"} subtitle="Persisted suppression list"><InputBlock label="DNC list name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} rows={2} /></div><div className="mt-3 grid grid-cols-2 gap-3"><ConfigSelect label="Status" value={draft.status} options={schema.dncListStatuses || ["draft", "active", "paused"]} onChange={(v) => update({ status: v })} /><ConfigSelect label="Match strategy" value={draft.match_strategy || "phone"} options={["phone", "email", "phone_or_email"]} onChange={(v) => update({ match_strategy: v })} /></div></SettingCard><CsvUploadCard title="DNC CSV upload" description="Choose a CSV, preview the first 10 records, and select valid suppression columns for the current match strategy." csv={csv} setCsv={setCsv} fileName={csvFileName} setFileName={setCsvFileName} preview={csvPreview} importConfig={csvImportConfig} setImportConfig={setCsvImportConfig} onImport={importCsv} importing={importing} disabled={false} buttonLabel="Upload" readiness={importReadiness} previewTitle="DNC CSV preview" previewDescription="Previewing up to 10 records. Columns are enabled only when sample values match the DNC strategy." showMappings={false} dncMatchStrategy={draft.match_strategy || "phone"} dncColumnStats={dncColumnStats} importedPreviewEndpoint={draft.id ? `${API}/dnc-lists/${draft.id}/preview` : null} hasImportedPreview={Number(draft.record_count || 0) > 0} importedPreviewTitle="Imported DNC preview" importedPreviewDescription="Read-only preview of up to 10 suppression entries stored in the database." /></div>;
}


function FilterSettingsForm({ filter, contactLists, schema, saveFilter, saving, registerHeaderSaveAction }) {
  const firstContactListId = contactLists[0]?.id || null;
  const withRequiredContactList = useCallback((next) => ({ ...next, contact_list_id: next?.contact_list_id || firstContactListId }), [firstContactListId]);
  const [draft, setDraft] = useState(() => withRequiredContactList(filter || defaultFilter()));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const testingRef = useRef(false);
  const [testResult, setTestResult] = useState(null);
  useEffect(() => { setDraft(withRequiredContactList(filter || defaultFilter())); setTestResult(null); setPreviewOpen(false); }, [filter, withRequiredContactList]);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const selectedList = contactLists.find((l) => l.id === draft.contact_list_id);
  const fieldOptions = contactListFieldOptions(selectedList, schema).map((name) => ({ value: name, label: name }));
  const fieldValues = fieldOptions.map((option) => option.value);
  const firstField = fieldOptions[0]?.value || "";
  const operators = ["is present", "equals", "does not equal", "contains", "greater than", "less than", "before", "after"];
  const conditions = draft.conditions || [];
  const normalizeConditionsForFields = useCallback((rows = []) => rows.map((row) => ({ ...row, field: fieldValues.includes(row.field) ? row.field : firstField })).filter((row) => row.field), [fieldValues, firstField]);
  useEffect(() => {
    if (!firstField) return;
    const nextConditions = normalizeConditionsForFields(conditions);
    if (JSON.stringify(nextConditions) !== JSON.stringify(conditions)) update({ conditions: nextConditions.length ? nextConditions : [{ field: firstField, operator: "is present", value: "" }] });
  }, [firstField, normalizeConditionsForFields, conditions]);
  const updateCondition = (idx, patch) => update({ conditions: conditions.map((row, i) => i === idx ? { ...row, ...patch } : row) });
  const removeCondition = (idx) => update({ conditions: conditions.filter((_, i) => i !== idx) });
  const addCondition = () => { if (firstField) update({ conditions: [...conditions, { field: firstField, operator: "is present", value: "" }] }); };
  const updateContactList = (contactListId) => {
    const validContactListId = contactLists.some((l) => l.id === contactListId) ? contactListId : null;
    const nextList = contactLists.find((l) => l.id === validContactListId);
    const nextFields = contactListFieldOptions(nextList, schema);
    const nextFirstField = nextFields[0] || "";
    update({ contact_list_id: validContactListId, conditions: nextFirstField ? normalizeConditionsForFields(conditions).map((row) => ({ ...row, field: nextFields.includes(row.field) ? row.field : nextFirstField })) : [] });
    setTestResult(null);
  };
  const runFilterTest = useCallback(async () => {
    if (!draft.contact_list_id) {
      const result = { ok: false, valid: false, validated: false, totalRecords: 0, matchingRecords: 0, sampleRows: [], columns: fieldValues, errors: ["Select a target contact list before testing this filter."], conditions };
      setTestResult(result);
      return result;
    }
    if (testingRef.current) return testResult;
    testingRef.current = true;
    setTesting(true);
    try {
      const result = await api(`${API}/filters/test`, { method: "POST", body: JSON.stringify({ contact_list_id: draft.contact_list_id, conditions }) });
      setTestResult(result);
      return result;
    } catch (err) {
      const result = { ok: false, valid: false, validated: false, totalRecords: 0, matchingRecords: 0, sampleRows: [], columns: fieldValues, errors: [err.message || "Filter test failed"], conditions };
      setTestResult(result);
      notify({ title: "Filter test failed", description: err.message, variant: "error" });
      return result;
    } finally { testingRef.current = false; setTesting(false); }
  }, [draft.contact_list_id, conditions, fieldValues, testResult]);
  const openTestPreview = async () => { setPreviewOpen(true); await runFilterTest(); };
  useEffect(() => { registerHeaderSaveAction({ section: "filters", label: "Save filter", disabled: saving || !draft.name?.trim() || !draft.contact_list_id, busy: saving, onSave: () => saveFilter(draft) }); return () => registerHeaderSaveAction(null); }, [draft, saving, saveFilter, registerHeaderSaveAction]);
  const contactListOptions = contactLists.length ? contactLists.map((l) => ({ value: l.id, label: l.name })) : [{ value: "__no_contact_lists__", label: "Create or import a contact list first", disabled: true }];
  const conditionFieldOptions = fieldOptions.length ? fieldOptions : [{ value: "__no_fields__", label: selectedList ? "No imported fields for this list" : "Select a contact list first", disabled: true }];
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconFilter} title={draft.id ? draft.name : "Filter configuration"} subtitle="Persisted metadata; test current unsaved conditions before saving"><InputBlock label="Name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" rows={2} value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} /></div><div className="mt-3 grid gap-3"><ConfigSelect label="Status" value={draft.status || "draft"} options={["draft", "active", "paused"]} onChange={(v) => update({ status: v })} /><ConfigSelect label="Target contact list" value={draft.contact_list_id || contactListOptions[0]?.value} options={contactListOptions} onChange={updateContactList} /></div></SettingCard><SettingCard icon={IconListDetails} title="Conditions" subtitle="Fields are loaded from the selected contact list import schema and row data"><FilterConditionsEditor conditions={conditions} conditionFieldOptions={conditionFieldOptions} firstField={firstField} operators={operators} selectedList={selectedList} updateCondition={updateCondition} removeCondition={removeCondition} addCondition={addCondition} /><div className="mt-3 flex flex-wrap items-center gap-2"><Button type="button" className="mt-0" size="sm" variant="outline" disabled={!firstField} onClick={addCondition}><IconPlus className="mr-2 h-4 w-4" />Add rule</Button><Button type="button" size="sm" onClick={openTestPreview} disabled={testing || !draft.contact_list_id} className={neutralActionClass}>{testing ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconEye className="mr-2 h-4 w-4" />}Test filter</Button></div></SettingCard><FilterTestPreviewSheet open={previewOpen} onOpenChange={setPreviewOpen} filterName={draft.name} selectedList={selectedList} conditions={conditions} conditionFieldOptions={conditionFieldOptions} firstField={firstField} operators={operators} updateCondition={updateCondition} removeCondition={removeCondition} addCondition={addCondition} result={testResult} testing={testing} onTest={runFilterTest} /></div>;
}

function FilterConditionsEditor({ conditions, conditionFieldOptions, firstField, operators, selectedList, updateCondition, removeCondition, addCondition }) {
  return <div className="space-y-2">{conditions.map((row, idx) => <div key={idx} className="rounded-xl border bg-muted/25 p-2"><div className="grid gap-2"><ConfigSelect bare value={row.field || firstField || conditionFieldOptions[0]?.value} options={conditionFieldOptions} onChange={(v) => updateCondition(idx, { field: v })} /><ConfigSelect bare value={row.operator || "is present"} options={operators} onChange={(v) => updateCondition(idx, { operator: v })} /><Input value={row.value || ""} placeholder="Value (optional)" onChange={(e) => updateCondition(idx, { value: e.target.value })} /><Button type="button" variant="ghost" size="sm" onClick={() => removeCondition(idx)}><IconX className="mr-2 h-4 w-4" />Remove</Button></div></div>)}{!conditions.length ? <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{selectedList ? "This contact list does not have imported fields yet. Import CSV columns before adding filter rules." : "Select a target contact list before adding rules."}</div> : null}{!conditions.length && firstField ? <Button type="button" className="mt-3" size="sm" variant="outline" onClick={addCondition}><IconPlus className="mr-2 h-4 w-4" />Add rule</Button> : null}</div>;
}

function FilterTestPreviewSheet({ open, onOpenChange, filterName, selectedList, conditions, conditionFieldOptions, firstField, operators, updateCondition, removeCondition, addCondition, result, testing, onTest }) {
  const columns = result?.columns?.length ? result.columns : conditionFieldOptions.filter((option) => !option.disabled).map((option) => option.value);
  const rows = result?.sampleRows || [];
  const totalConsidered = Number(result?.totalRecordsConsidered ?? result?.totalRecords ?? 0) || 0;
  const scanned = Number(result?.scannedRecords ?? totalConsidered) || 0;
  const matching = Number(result?.matchingRecords || 0);
  const scanLimit = Number(result?.scanLimit || 0);
  const limited = Boolean(result?.limited || result?.capped);
  const scannedDisplay = limited ? `${scanned.toLocaleString()}+` : scanned.toLocaleString();
  const countSummary = limited
    ? `Scanned ${scanned.toLocaleString()} records within the capped preview${scanLimit ? ` (limit ${scanLimit.toLocaleString()})` : ""}; more records exist beyond the cap.`
    : `Scanned all ${scanned.toLocaleString()} record${scanned === 1 ? "" : "s"} in this list.`;
  const errors = result?.errors || [];
  const valid = Boolean(result?.valid || result?.validated);
  const previewRowCount = 10;
  const visibleRecordRows = rows.length || 1;
  const placeholderRows = Array.from({ length: Math.max(0, previewRowCount - visibleRecordRows) });
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="bottom" showCloseButton={false} className="max-h-[calc(100vh-1rem)] gap-0 overflow-hidden rounded-t-3xl bg-background p-0"><SheetHeader className="border-b bg-card/95 px-6 py-4 shadow-sm"><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 to-violet-500/20 text-sky-600 shadow-sm shadow-sky-500/10 dark:text-sky-300"><IconFilter className="h-5 w-5" /></span><div className="min-w-0"><SheetTitle className="truncate text-base">Test filter{filterName ? ` · ${filterName}` : ""}</SheetTitle><SheetDescription>Preview current unsaved conditions against {selectedList?.name || "the selected contact list"}. Changes here sync back to Context Settings.</SheetDescription></div></div></div><div className="flex shrink-0 flex-wrap items-center gap-2"><Badge variant="outline" className={valid ? "border-emerald-500/45 bg-emerald-500/10 px-3 py-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300" : "border-amber-500/45 bg-amber-500/10 px-3 py-1 text-sm font-semibold text-amber-700 dark:text-amber-300"}>{valid ? "Validated" : "Needs setup"}</Badge><Badge variant="outline" className={limited ? "border-amber-500/45 bg-amber-500/10 px-3 py-1 text-sm font-semibold text-amber-700 dark:text-amber-300" : "border-sky-500/45 bg-sky-500/10 px-3 py-1 text-sm font-semibold text-sky-700 dark:text-sky-300"}><span className="mr-1 text-[10px] uppercase tracking-wide opacity-75">Scanned</span>{scannedDisplay}</Badge><Badge variant="outline" className="border-emerald-500/45 bg-emerald-500/10 px-3 py-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300"><span className="mr-1 text-[10px] uppercase tracking-wide opacity-75">{limited ? "Matched in scan" : "Matching"}</span>{matching.toLocaleString()}</Badge>{limited && scanLimit ? <Badge variant="outline" className="border-amber-500/45 bg-amber-500/10 px-3 py-1 text-sm font-semibold text-amber-700 dark:text-amber-300"><span className="mr-1 text-[10px] uppercase tracking-wide opacity-75">Limit</span>{scanLimit.toLocaleString()}</Badge> : null}<Button type="button" size="sm" variant="outline" onClick={onTest} disabled={testing} className="bg-background/80">{testing ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconRefresh className="mr-2 h-4 w-4" />}Apply filter</Button><Button type="button" size="sm" onClick={() => onOpenChange?.(false)} className={neutralActionClass}><IconCheck className="mr-2 h-4 w-4" />Update</Button></div></div></SheetHeader><div className="grid max-h-[calc(100vh-11rem)] gap-4 overflow-auto p-6 lg:grid-cols-[360px_minmax(0,1fr)]"><div className="space-y-3"><div className="rounded-2xl border bg-background/90 p-4 shadow-sm"><div className="mb-3 text-sm font-semibold">Preview conditions</div><FilterConditionsEditor conditions={conditions} conditionFieldOptions={conditionFieldOptions} firstField={firstField} operators={operators} selectedList={selectedList} updateCondition={updateCondition} removeCondition={removeCondition} addCondition={addCondition} /></div>{errors.length ? <div className="rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200"><div className="font-semibold">Validation</div><ul className="mt-2 list-disc space-y-1 pl-4">{errors.map((error, idx) => <li key={idx}>{error}</li>)}</ul></div> : <div className="rounded-2xl border border-emerald-500/35 bg-emerald-500/10 p-4 text-sm text-emerald-800 dark:text-emerald-200">Filter is valid for the selected contact list fields.</div>}</div><div className="min-w-0 rounded-2xl border bg-background/90 shadow-sm"><div className="border-b px-4 py-3"><div className="text-sm font-semibold">Sample matching rows</div><p className="text-xs text-muted-foreground">Showing up to 10 matching records from imported row_data. {result ? countSummary : "Run the test to scan this list."}</p></div><div className="overflow-auto"><Table><TableHeader><TableRow className="bg-muted/50 hover:bg-muted/50">{columns.length ? columns.map((column) => <TableHead key={column} className="min-w-44 font-mono text-xs">{column}</TableHead>) : <TableHead>No fields</TableHead>}</TableRow></TableHeader><TableBody>{rows.length ? rows.map((record, idx) => <TableRow key={idx} className="h-9">{columns.map((column) => <TableCell key={`${idx}-${column}`} className="h-9 max-w-64 truncate py-2 text-xs" title={record[column]}>{record[column] || "—"}</TableCell>)}</TableRow>) : <TableRow className="h-9"><TableCell colSpan={Math.max(columns.length, 1)} className="h-9 py-2 text-center text-muted-foreground">{testing ? "Testing filter…" : valid ? "No records match these conditions." : "Fix validation issues and apply the filter to preview rows."}</TableCell></TableRow>}{placeholderRows.map((_, idx) => <TableRow key={`filter-placeholder-${idx}`} className="h-9 hover:bg-transparent"><TableCell colSpan={Math.max(columns.length, 1)} className="h-9 py-2 text-xs text-transparent" aria-hidden="true">—</TableCell></TableRow>)}</TableBody></Table></div></div></div></SheetContent></Sheet>;
}

function TimeSetSettingsForm({ timeSet, saveTimeSet, saving, registerHeaderSaveAction }) {
  const [draft, setDraft] = useState(timeSet || defaultTimeSet());
  const [view, setView] = useState("detail");
  useEffect(() => { setDraft(timeSet || defaultTimeSet()); setView(timeSet?.metadata?.view || "detail"); }, [timeSet]);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const windows = draft.windows || [];
  const dayWindow = (day) => windows.find((w) => w.day === day) || { day, enabled: false, start: "09:00", end: "17:00" };
  const updateDay = (day, patch) => { const exists = windows.some((w) => w.day === day); update({ windows: exists ? windows.map((w) => w.day === day ? { ...w, ...patch } : w) : [...windows, { day, enabled: true, start: "09:00", end: "17:00", ...patch }] }); };
  const save = useCallback(() => saveTimeSet({ ...draft, metadata: { ...(draft.metadata || {}), view } }), [draft, view, saveTimeSet]);
  useEffect(() => { registerHeaderSaveAction({ section: "time-sets", label: "Save time set", disabled: saving || !draft.name?.trim(), busy: saving, onSave: save }); return () => registerHeaderSaveAction(null); }, [draft, saving, save, registerHeaderSaveAction]);
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconCalendar} title={draft.id ? draft.name : "Time set configuration"} subtitle="Timezone-aware weekly windows"><InputBlock label="Name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3 grid gap-3"><InputBlock label="Time Zone" value={draft.timezone || "Europe/Warsaw"} onChange={(v) => update({ timezone: v })} /><ConfigSelect label="Status" value={draft.status || "draft"} options={["draft", "active", "paused"]} onChange={(v) => update({ status: v })} /></div><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" rows={2} value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} /></div></SettingCard><div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/30 p-1"><Button type="button" variant={view === "calendar" ? "default" : "ghost"} size="sm" onClick={() => setView("calendar")}>Calendar View</Button><Button type="button" variant={view === "detail" ? "default" : "ghost"} size="sm" onClick={() => setView("detail")}>Detail View</Button></div>{view === "calendar" ? <TimeSetCalendar windows={windows} /> : <SettingCard icon={IconListDetails} title="Detail View" subtitle="Start is inclusive; stop is exclusive"><div className="space-y-2">{WEEKDAYS.map((day) => { const row = dayWindow(day.id); return <div key={day.id} className="grid grid-cols-[54px_70px_1fr_1fr] items-center gap-2 rounded-lg border bg-background/70 p-2 text-sm"><div className="font-medium">{day.label}</div><Switch checked={row.enabled !== false} onCheckedChange={(v) => updateDay(day.id, { enabled: v })} /><Input type="time" value={row.start || "09:00"} onChange={(e) => updateDay(day.id, { start: e.target.value })} /><Input type="time" value={row.end || "17:00"} onChange={(e) => updateDay(day.id, { end: e.target.value })} /></div>; })}</div></SettingCard>}</div>;
}

function TimeSetCalendar({ windows }) {
  const hours = Array.from({ length: 12 }, (_, idx) => idx + 7);
  const activeFor = (day, hour) => (windows || []).some((w) => w.day === day && w.enabled !== false && Number((w.start || "00:00").slice(0, 2)) <= hour && hour < Number((w.end || "00:00").slice(0, 2)));
  return <SettingCard icon={IconCalendar} title="Calendar View" subtitle="Derived weekly visualization; edit ranges in Detail View"><div className="overflow-hidden rounded-xl border text-[10px]"><div className="grid grid-cols-[42px_repeat(7,1fr)] bg-muted/50"><span className="p-2">Hour</span>{WEEKDAYS.map((d) => <span key={d.id} className="border-l p-2 text-center font-semibold">{d.label}</span>)}</div>{hours.map((hour) => <div key={hour} className="grid grid-cols-[42px_repeat(7,1fr)] border-t"><span className="p-2 text-muted-foreground">{String(hour).padStart(2, "0")}:00</span>{WEEKDAYS.map((d) => <span key={d.id} className={`min-h-7 border-l ${activeFor(d.id, hour) ? "bg-gradient-to-r from-sky-500/30 to-violet-500/25" : "bg-background/60"}`} />)}</div>)}</div></SettingCard>;
}

function parseCsvPreview(csvText) {
  const rows = [];
  let cell = "";
  let row = [];
  let quoted = false;
  const text = String(csvText || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (char !== "\r") cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() || []).map((h, idx) => String(h || `Column ${idx + 1}`).trim() || `Column ${idx + 1}`);
  const records = rows.filter((r) => r.some((c) => String(c || "").trim())).map((r) => Object.fromEntries(headers.map((h, idx) => [h, String(r[idx] || "").trim()])));
  return { headers, records, totalRows: records.length, previewRecords: records.slice(0, 10), headersKey: headers.join("\u001f") };
}

function normalizeCsvImportConfig(settings = {}) {
  return { selectedColumns: settings.selectedColumns || settings.selected_columns || [], columnMappings: settings.columnMappings || settings.column_mappings || {}, noDuplicateColumns: settings.noDuplicateColumns || settings.no_duplicate_columns || [], columnFilters: settings.columnFilters || settings.column_filters || {} };
}

function buildCsvImportMetadata(headers, config, fileName) {
  const selectedColumns = (Array.isArray(config.selectedColumns) ? config.selectedColumns : headers).filter((column) => headers.includes(column));
  const columnMappings = Object.fromEntries(Object.entries(config.columnMappings || {}).map(([column, values]) => [column, (Array.isArray(values) ? values : []).filter(Boolean)]).filter(([column]) => headers.includes(column)));
  const rules = normalizeCsvImportRules(headers, config);
  return { selected_columns: selectedColumns, column_mappings: columnMappings, no_duplicate_columns: rules.no_duplicate_columns, column_filters: rules.column_filters, source_file_name: fileName || null, updated_at: new Date().toISOString() };
}

function csvSelectedColumns(headers, config) {
  const selected = Array.isArray(config?.selectedColumns) ? config.selectedColumns : headers;
  return headers.length ? selected.filter((column) => headers.includes(column)) : selected.filter(Boolean);
}

function csvHasContactMapping(selectedColumns, columnMappings = {}) {
  return selectedColumns.some((column) => (columnMappings[column] || []).some((value) => CSV_CONTACT_MAPPING_PREFIXES.some((prefix) => String(value).startsWith(prefix))));
}

function getCsvImportReadiness(csv, headers, config) {
  if (!csv?.trim()) return { ready: false, message: "Choose a CSV file first." };
  if (!headers.length) return { ready: false, message: "Open a CSV with a header row before importing." };
  const selectedColumns = csvSelectedColumns(headers, config);
  if (!selectedColumns.length) return { ready: false, message: "Select at least one column in the CSV preview before importing." };
  if (!csvHasContactMapping(selectedColumns, config?.columnMappings || {})) return { ready: false, message: "Map at least one selected column to Number, Email, or WhatsApp before importing. Voice/WhatsApp campaigns will use Number or WhatsApp mappings; Email campaigns will use Email mappings when campaign-specific validation is added." };
  return { ready: true, message: "Ready to import selected columns and contact mappings." };
}

function normalizePreviewPhone(value) { const digits = String(value || "").replace(/[^0-9]/g, ""); return digits.length >= 7 && digits.length <= 16 ? digits : null; }
function normalizePreviewEmail(value) { const email = String(value || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null; }
function classifyDncPreviewColumns(records = [], headers = []) {
  return Object.fromEntries(headers.map((column) => {
    const samples = (records || []).map((record) => String(record?.[column] || "").trim()).filter(Boolean).slice(0, 25);
    const phoneMatches = samples.filter(normalizePreviewPhone).length;
    const emailMatches = samples.filter(normalizePreviewEmail).length;
    return [column, { sampleCount: samples.length, phoneMatches, emailMatches, isPhone: samples.length > 0 && phoneMatches > 0 && phoneMatches >= emailMatches && phoneMatches / samples.length >= 0.5, isEmail: samples.length > 0 && emailMatches > 0 && emailMatches >= phoneMatches && emailMatches / samples.length >= 0.5 }];
  }));
}
function dncColumnAllowed(stats, strategy = "phone") {
  if (!stats) return false;
  if (strategy === "email") return stats.isEmail;
  if (strategy === "phone_or_email") return stats.isPhone || stats.isEmail;
  return stats.isPhone;
}
function getDncCsvImportReadiness(csv, headers, config, strategy = "phone", columnStats = {}) {
  if (!csv?.trim()) return { ready: false, message: "Choose a CSV file first." };
  if (!headers.length) return { ready: false, message: "Open a CSV with a header row before importing." };
  const selectedColumns = csvSelectedColumns(headers, config);
  if (!selectedColumns.length) return { ready: false, message: "Select at least one DNC column in the CSV preview before importing." };
  const invalid = selectedColumns.filter((column) => !dncColumnAllowed(columnStats[column], strategy));
  if (invalid.length) return { ready: false, message: `Selected column(s) do not match ${title(strategy)} DNC values: ${invalid.join(", ")}.` };
  return { ready: true, message: "Ready to import valid DNC suppression columns." };
}

function inferCsvFieldType(name, explicitType) {
  if (explicitType) return explicitType;
  const lower = String(name || "").toLowerCase();
  if (lower.includes("email")) return "email";
  if (lower.includes("phone") || lower.includes("mobile") || lower.includes("number") || lower.includes("whatsapp")) return "phone";
  if (lower.includes("date")) return "date";
  return "text";
}

function schemaForSelectedCsvColumns(headers, config, existingSchema = []) {
  const byName = new Map((Array.isArray(existingSchema) ? existingSchema : []).map((field) => [field?.name, field]).filter(([name]) => name));
  return csvSelectedColumns(headers, config).map((name) => {
    const existing = byName.get(name) || {};
    return { name, type: inferCsvFieldType(name, existing.type), required: Boolean(existing.required), label: existing.label || name };
  });
}

function upsertFieldSchemaType(schema = [], fieldName, type) {
  const fields = Array.isArray(schema) ? schema : [];
  if (fields.some((field) => field?.name === fieldName)) return fields.map((field) => field?.name === fieldName ? { ...field, type } : field);
  return [...fields, { name: fieldName, type, required: false, label: fieldName }];
}

function CsvUploadCard({ title: cardTitle, description, csv, setCsv, fileName = "", setFileName = () => {}, preview, importConfig, setImportConfig, onImport, importing, disabled, buttonLabel, showTextarea = false, readiness, previewTitle, previewDescription, showMappings = true, dncMatchStrategy, dncColumnStats, importedPreviewEndpoint, hasImportedPreview = false, importedPreviewTitle, importedPreviewDescription }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dbPreview, setDbPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const inputId = `${cardTitle.replace(/\s+/g, "-").toLowerCase()}-file`;
  const handleCsvText = async (file) => { if (!file) return; setCsv(await file.text()); setFileName(file.name || "selected.csv"); setDbPreview(null); };
  const handleDrop = async (event) => { event.preventDefault(); await handleCsvText(event.dataTransfer?.files?.[0]); };
  const handleFile = async (event) => { await handleCsvText(event.target.files?.[0]); event.target.value = ""; };
  const hasCsv = Boolean(csv?.trim());
  const canPreview = Boolean((preview && hasCsv) || (importedPreviewEndpoint && hasImportedPreview));
  const importDisabled = importing || disabled || (readiness ? !readiness.ready : !hasCsv);
  const openPreview = async () => {
    if (hasCsv) { setPreviewOpen(true); return; }
    if (!importedPreviewEndpoint) return;
    setLoadingPreview(true);
    try { setDbPreview(await api(importedPreviewEndpoint)); setPreviewOpen(true); }
    catch (err) { notify({ title: "Preview failed", description: err.message, variant: "error" }); }
    finally { setLoadingPreview(false); }
  };
  const activePreview = hasCsv ? preview : { headers: dbPreview?.columns || [], records: dbPreview?.records || [], previewRecords: dbPreview?.records || [], totalRows: dbPreview?.records?.length || 0, headersKey: (dbPreview?.columns || []).join("\u001f") };
  return <SettingCard icon={IconUpload} title={cardTitle} subtitle={description}><div onDragOver={(e) => e.preventDefault()} onDrop={handleDrop} className="rounded-xl border border-dashed bg-gradient-to-br from-sky-500/10 to-violet-500/10 p-4 text-center text-sm text-muted-foreground"><IconUpload className="mx-auto mb-2 h-5 w-5 text-sky-600" />Drag and drop a CSV file here, or choose one below.</div><div className="mt-3 flex items-center justify-between gap-2"><div className="min-w-0 flex-1"><Label htmlFor={inputId} className="flex cursor-pointer items-center justify-between gap-2 rounded-md border bg-background/80 px-3 py-2 text-sm hover:bg-muted"><span className="truncate">Choose CSV</span>{hasCsv ? <Badge variant="outline" className="shrink-0 font-normal">{preview.totalRows ?? (preview.records?.length || 0)} rows</Badge> : hasImportedPreview ? <Badge variant="outline" className="shrink-0 font-normal">Imported</Badge> : null}</Label><Input id={inputId} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} /></div><Button type="button" size="icon" variant="outline" onClick={openPreview} disabled={!canPreview || loadingPreview} title={hasCsv ? "Preview CSV" : hasImportedPreview ? "Preview imported database records" : "Choose a CSV first"}>{loadingPreview ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconEye className="h-4 w-4" />}</Button><Button size="sm" variant="outline" onClick={onImport} disabled={importDisabled}>{importing ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconUpload className="mr-2 h-4 w-4" />}{buttonLabel}</Button></div>{fileName ? <p className="mt-2 truncate text-xs text-muted-foreground">Selected file: {fileName}</p> : null}{readiness ? <p className={`mt-2 text-xs ${readiness.ready ? "text-emerald-600 dark:text-emerald-300" : "text-muted-foreground"}`}>{readiness.message}</p> : null}{showTextarea ? <Textarea className="mt-3 font-mono text-xs" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} /> : null}{preview && importConfig && setImportConfig ? <CsvPreviewSheet open={previewOpen} onOpenChange={setPreviewOpen} preview={activePreview} importConfig={importConfig} setImportConfig={setImportConfig} title={hasCsv ? previewTitle : importedPreviewTitle || previewTitle} description={hasCsv ? previewDescription : importedPreviewDescription || "Read-only preview of imported database records."} showMappings={hasCsv && showMappings} readOnly={!hasCsv} dncMatchStrategy={hasCsv ? dncMatchStrategy : null} dncColumnStats={hasCsv ? dncColumnStats : null} /> : null}</SettingCard>;
}

function CsvPreviewSheet({ open, onOpenChange, preview, importConfig, setImportConfig, title: sheetTitle = "CSV preview and channel mapping", description = "Previewing up to 10 records. Select import columns and map each one to Attempt Control contact channels.", showMappings = true, readOnly = false, dncMatchStrategy = null, dncColumnStats = null }) {
  const selectedColumns = Array.isArray(importConfig.selectedColumns) ? importConfig.selectedColumns : preview.headers;
  const [applied, setApplied] = useState(() => applyCsvImportRules(preview.records || [], preview.headers || [], importConfig));
  useEffect(() => { if (open) setApplied(applyCsvImportRules(preview.records || [], preview.headers || [], importConfig)); }, [open, preview.headersKey, preview.records, importConfig, preview.headers]);
  const previewRowCount = 10;
  const displayedRecords = (applied.records || []).slice(0, previewRowCount);
  const visibleRecordRows = displayedRecords.length || 1;
  const placeholderRows = Array.from({ length: Math.max(0, previewRowCount - visibleRecordRows) });
  const remainingRows = applied.records?.length || 0;
  const totalRows = preview.totalRows ?? preview.records?.length ?? 0;
  const HeaderIcon = showMappings ? IconDatabase : IconShieldCheck;
  const isColumnAllowed = (column) => !dncMatchStrategy || dncColumnAllowed(dncColumnStats?.[column], dncMatchStrategy);
  const toggleColumn = (column, checked) => {
    if (readOnly || !isColumnAllowed(column)) return;
    setImportConfig((config) => {
      const current = Array.isArray(config.selectedColumns) ? config.selectedColumns : preview.headers;
      return { ...config, selectedColumns: checked ? [...new Set([...current, column])] : current.filter((value) => value !== column) };
    });
  };
  const updateMappings = (column, values) => { if (!readOnly) setImportConfig((config) => ({ ...config, columnMappings: { ...(config.columnMappings || {}), [column]: values } })); };
  const toggleNoDuplicate = (column, checked) => {
    if (readOnly) return;
    setImportConfig((config) => {
      const current = Array.isArray(config.noDuplicateColumns) ? config.noDuplicateColumns : [];
      return { ...config, noDuplicateColumns: checked ? [...new Set([...current, column])] : current.filter((value) => value !== column) };
    });
  };
  const updateFilter = (column, patch) => { if (!readOnly) setImportConfig((config) => ({ ...config, columnFilters: { ...(config.columnFilters || {}), [column]: { operator: "any", value: "", ...(config.columnFilters?.[column] || {}), ...patch } } })); };
  const applyPreview = () => { if (!readOnly) setApplied(applyCsvImportRules(preview.records || [], preview.headers || [], importConfig)); };
  const updateSheet = () => {
    if (readOnly) { onOpenChange?.(false); return; }
    setApplied(applyCsvImportRules(preview.records || [], preview.headers || [], importConfig));
    notify({ title: "CSV preview settings updated", description: "The current preview configuration is saved for this import.", variant: "success" });
    onOpenChange?.(false);
  };
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="bottom" showCloseButton={false} className="max-h-[calc(100vh-1rem)] gap-0 overflow-hidden rounded-t-3xl bg-background p-0"><SheetHeader className="border-b bg-card/95 px-6 py-4 shadow-sm"><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 to-violet-500/20 text-sky-600 shadow-sm shadow-sky-500/10 dark:text-sky-300"><HeaderIcon className="h-5 w-5" /></span><div className="min-w-0"><SheetTitle className="truncate text-base">{sheetTitle}</SheetTitle><SheetDescription>{description}</SheetDescription></div></div></div><div className="flex shrink-0 flex-wrap items-center gap-2"><Badge variant="outline" className="border-sky-500/45 bg-sky-500/10 px-3 py-1 text-sm font-semibold text-sky-700 dark:text-sky-300"><span className="mr-1 text-[10px] uppercase tracking-wide opacity-75">Total</span>{Number(totalRows || 0).toLocaleString()}</Badge><Badge variant="outline" className="border-emerald-500/45 bg-emerald-500/10 px-3 py-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300"><span className="mr-1 text-[10px] uppercase tracking-wide opacity-75">Remaining</span>{remainingRows.toLocaleString()}</Badge>{readOnly ? <Badge variant="outline" className="border-slate-400/45 bg-slate-500/10 px-3 py-1 text-sm font-semibold text-slate-600 dark:text-slate-300">Read only</Badge> : <><Button type="button" size="sm" variant="outline" onClick={applyPreview} className="bg-background/80"><IconRefresh className="mr-2 h-4 w-4" />Apply filters</Button><Button type="button" size="sm" onClick={updateSheet} className={neutralActionClass}><IconCheck className="mr-2 h-4 w-4" />Update</Button></>}</div></div></SheetHeader><div className="max-h-[calc(100vh-11rem)] overflow-auto p-6"><div className="min-w-max rounded-2xl border bg-background/90 shadow-sm"><Table><TableHeader><TableRow className="bg-muted/50 hover:bg-muted/50">{preview.headers.map((column) => <TableHead key={column} className="min-w-44 align-top"><div className="flex items-center gap-2"><Checkbox checked={readOnly || selectedColumns.includes(column)} disabled={readOnly || !isColumnAllowed(column)} onCheckedChange={(checked) => toggleColumn(column, checked === true)} /><span className={`font-mono text-xs ${!isColumnAllowed(column) ? "text-muted-foreground line-through" : ""}`}>{column}</span>{dncMatchStrategy && !isColumnAllowed(column) ? <Badge variant="outline" className="text-[10px] font-normal">Invalid</Badge> : null}</div></TableHead>)}</TableRow>{showMappings ? <TableRow className="bg-muted/30 hover:bg-muted/30">{preview.headers.map((column) => <TableHead key={`${column}-mapping`} className="min-w-44 py-2"><ColumnMappingSelect column={column} values={importConfig.columnMappings?.[column] || []} onChange={(values) => updateMappings(column, values)} /></TableHead>)}</TableRow> : null}{!readOnly ? <><TableRow className="bg-muted/20 hover:bg-muted/20">{preview.headers.map((column) => <TableHead key={`${column}-dedupe`} className="min-w-44 py-2"><label className="flex items-center gap-2 text-xs font-normal text-muted-foreground"><Checkbox checked={(importConfig.noDuplicateColumns || []).includes(column)} onCheckedChange={(checked) => toggleNoDuplicate(column, checked === true)} />No duplicates</label></TableHead>)}</TableRow><TableRow className="bg-muted/20 hover:bg-muted/20">{preview.headers.map((column) => <TableHead key={`${column}-filter-operator`} className="min-w-44 py-2"><Select value={importConfig.columnFilters?.[column]?.operator || "any"} onValueChange={(operator) => updateFilter(column, { operator, value: CSV_FILTER_OPERATORS.find((item) => item.value === operator)?.needsValue === false ? "" : importConfig.columnFilters?.[column]?.value || "" })}><SelectTrigger className="h-8 bg-background text-xs"><SelectValue /></SelectTrigger><SelectContent>{CSV_FILTER_OPERATORS.map((operator) => <SelectItem key={operator.value} value={operator.value}>{operator.label}</SelectItem>)}</SelectContent></Select></TableHead>)}</TableRow><TableRow className="bg-muted/10 hover:bg-muted/10">{preview.headers.map((column) => { const operator = importConfig.columnFilters?.[column]?.operator || "any"; const disabled = CSV_FILTER_OPERATORS.find((item) => item.value === operator)?.needsValue === false; return <TableHead key={`${column}-filter-value`} className="min-w-44 py-2"><Input className="h-8 text-xs" value={importConfig.columnFilters?.[column]?.value || ""} disabled={disabled} placeholder={disabled ? "No value" : "Filter value"} onChange={(event) => updateFilter(column, { value: event.target.value })} /></TableHead>; })}</TableRow></> : null}</TableHeader><TableBody>{displayedRecords.length ? displayedRecords.map((record, idx) => <TableRow key={idx} className="h-9">{preview.headers.map((column) => <TableCell key={`${idx}-${column}`} className="h-9 max-w-64 truncate py-2 text-xs" title={record[column]}>{record[column] || "—"}</TableCell>)}</TableRow>) : <TableRow className="h-9"><TableCell colSpan={Math.max(preview.headers.length, 1)} className="h-9 py-2 text-center text-muted-foreground">No records remain after the header row, filters, and duplicate checks.</TableCell></TableRow>}{placeholderRows.map((_, idx) => <TableRow key={`placeholder-${idx}`} className="h-9 hover:bg-transparent"><TableCell colSpan={Math.max(preview.headers.length, 1)} className="h-9 py-2 text-xs text-transparent" aria-hidden="true">—</TableCell></TableRow>)}</TableBody></Table></div></div></SheetContent></Sheet>;
}

function ColumnMappingSelect({ column, values = [], onChange }) {
  const [open, setOpen] = useState(false);
  const toggle = (value) => onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  const selectedSummary = values.length ? `${values.length} mapped` : "Map fields";
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" variant="outline" className="h-8 min-w-40 justify-between gap-2 bg-background px-3 text-xs font-normal shadow-sm hover:bg-muted/60"><span className={values.length ? "text-foreground" : "text-muted-foreground"}>{selectedSummary}</span><IconChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} /></Button></PopoverTrigger><PopoverContent align="start" className="w-72 max-h-[min(34rem,calc(100vh-8rem))] overflow-hidden rounded-xl border bg-popover p-1.5 shadow-xl"><div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">Map <span className="font-mono text-foreground">{column}</span> to one or more contact channels.</div><div className="max-h-[min(30rem,calc(100vh-12rem))] overflow-y-auto overscroll-contain pr-1">{CSV_CONTACT_MAPPING_GROUPS.map((group) => { const GroupIcon = group.icon; return <div key={group.group} className="py-1"><div className="mb-1 px-1"><span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${group.labelClass}`}><GroupIcon className={`h-3.5 w-3.5 ${group.iconClass}`} />{group.group}</span></div><div className="grid gap-0.5">{group.options.map((option) => { const value = `${group.group.toLowerCase()}:${option}`; const selected = values.includes(value); return <button key={`${column}-${value}`} type="button" onClick={() => toggle(value)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${selected ? "border-emerald-500 bg-emerald-500 text-white shadow-sm shadow-emerald-500/20" : "border-muted-foreground/30 bg-background"}`}>{selected ? <IconCheck className="h-3 w-3 stroke-[3]" /> : null}</span><span className="font-medium text-foreground">{title(option)}</span></button>; })}</div></div>; })}</div></PopoverContent></Popover>;
}

function DashboardMonitorPanel({ campaign, contactLists }) {
  if (!campaign) return <div className="flex-1 min-h-0 overflow-y-auto p-4"><Empty title="No campaign selected" description="Published campaigns appear here once they are out of draft/design status." /></div>;
  const progress = campaignContactProgress(campaign, contactLists);
  const live = campaignLiveMetrics(campaign);
  const timeline = campaignTimeline(campaign);
  const breakdown = [
    ["Ringing", live.ringing],
    ["Answered", live.answered],
    ["Hangup", live.hangups],
    ["Failed", live.failed],
    ["Machine", live.machine],
    ["No answer", live.noAnswer],
  ];
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconPhoneCall} title="Execution status" subtitle={campaign.name}><div className="space-y-3"><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">State</span><Badge variant="outline" className={statusClass(campaign.status)}>{title(executionStateFor(campaign))}</Badge></div><div><div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>{progress.completed.toLocaleString()} of {progress.total.toLocaleString()} records</span><span>{progress.remaining.toLocaleString()} remaining</span></div><Progress className="h-2" value={progress.progress} /></div><p className="text-xs text-muted-foreground">Progress source: {progress.source}. Worker execution is scaffolded unless metadata/events are present.</p></div></SettingCard><SettingCard icon={IconReportAnalytics} title="Live call states" subtitle="Webhook-event concepts"><div className="grid grid-cols-2 gap-2 text-xs"><MiniStat label="Active" value={live.active} /><MiniStat label="Answered" value={live.answered} /></div><div className="mt-3 space-y-2">{breakdown.map(([label, value]) => <div key={label} className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-sm"><span>{label}</span><span className="font-semibold">{Number(value || 0).toLocaleString()}</span></div>)}</div></SettingCard><SettingCard icon={IconListDetails} title="Event timeline" subtitle="Scaffolded monitor"><div className="space-y-2">{timeline.length ? timeline.map((event, idx) => <div key={`${event?.type || "event"}-${idx}`} className="rounded-lg border bg-muted/30 p-3 text-xs"><div className="font-semibold">{title(event?.type || event?.state || "event")}</div><div className="mt-1 text-muted-foreground">{event?.at || event?.timestamp || event?.created_at || "timestamp unavailable"}</div></div>) : <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">No real attempt/event table is connected yet. This panel will render webhook-derived ringing, answered, hangup, failed, machine, and no-answer events when they are persisted in campaign metadata or a future event store.</div>}</div></SettingCard></div>;
}

function MappingEditor({ campaign, contactLists, update }) { const list = contactLists.find((l) => l.id === campaign.contact_list_id); const fields = contactListFieldOptions(list); const mapping = campaign.form_variable_mapping || []; const add = () => update({ form_variable_mapping: [...mapping, { source: fields[0] || "", target: "customer.phone", required: false }] }); return <div className="mt-5 rounded-xl border bg-gradient-to-br from-sky-500/10 to-violet-500/10 p-4"><div className="flex items-center justify-between"><div><div className="flex items-center gap-2 font-semibold"><IconForms className="h-4 w-4 text-sky-600" />Forms variable mapping</div><p className="mt-1 text-sm text-muted-foreground">Map selected contact-list fields into variables a Form can consume.</p></div><Button size="sm" variant="outline" onClick={add}>Add mapping</Button></div><div className="mt-4 overflow-hidden rounded-xl border text-sm"><div className="grid grid-cols-[1fr_1fr_70px] bg-muted/60 px-3 py-2 text-xs font-semibold text-muted-foreground"><span>Contact field</span><span>Form variable</span><span>Req.</span></div>{mapping.length ? mapping.map((row, idx) => <div key={idx} className="grid grid-cols-[1fr_1fr_70px] items-center gap-2 border-t px-3 py-2"><Select value={row.source || fields[0]} onValueChange={(v) => update({ form_variable_mapping: mapping.map((m, i) => i === idx ? { ...m, source: v } : m) })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{fields.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent></Select><Input value={row.target || ""} onChange={(e) => update({ form_variable_mapping: mapping.map((m, i) => i === idx ? { ...m, target: e.target.value } : m) })} placeholder="customer.phone" /><Switch checked={Boolean(row.required)} onCheckedChange={(v) => update({ form_variable_mapping: mapping.map((m, i) => i === idx ? { ...m, required: v } : m) })} /></div>) : <div className="px-3 py-4 text-sm text-muted-foreground">No mappings yet. Add one when a contact list and Form are attached.</div>}</div></div>; }
function PanelHeader({ title, description }) { return <div className="h-16 shrink-0 border-b px-4 flex flex-col justify-center"><h2 className="text-sm font-semibold">{title}</h2><p className="text-xs text-muted-foreground">{description}</p></div>; }
function MiniStat({ label, value, icon: Icon, tone = "blue" }) { return <div className="rounded-lg border bg-muted/40 p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 truncate text-sm font-semibold">{value}</div></div>{Icon ? <span className={`shrink-0 rounded-lg bg-gradient-to-br p-1.5 ${toneClasses[tone] || toneClasses.blue}`}><Icon className="h-3.5 w-3.5" /></span> : null}</div></div>; }
function ConfigSelect({ label, value, options = [], onChange = () => {}, bare = false }) { const normalized = options.map((o) => typeof o === "string" ? { value: o, label: title(o) } : o); const select = <Select value={value || normalized[0]?.value} onValueChange={onChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{normalized.map((o) => <SelectItem key={o.value} value={o.value} disabled={Boolean(o.disabled)}>{o.label}</SelectItem>)}</SelectContent></Select>; return bare ? select : <div className="space-y-2"><Label>{label}</Label>{select}</div>; }
function InputBlock({ label, value, onChange = () => {}, type = "text" }) { return <div className="space-y-2"><Label>{label}</Label><Input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)} /></div>; }
function MultiSelect({ label, values = [], options = [], onChange = () => {}, emptyLabel = "No options available" }) { const normalized = options.map((o) => typeof o === "string" ? { value: o, label: o } : o); const selected = normalized.filter((o) => values.includes(o.value)); const toggle = (value) => onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]); return <div className="space-y-2"><Label>{label}</Label><Select value="multi" onValueChange={toggle}><SelectTrigger><SelectValue placeholder={selected.length ? `${selected.length} selected` : "Select values"}>{selected.length ? `${selected.length} selected` : "Select values"}</SelectValue></SelectTrigger><SelectContent>{normalized.length ? normalized.map((o) => <SelectItem key={o.value} value={o.value}><span className="mr-2">{values.includes(o.value) ? "☑" : "☐"}</span>{o.label}</SelectItem>) : <SelectItem value="empty" disabled>{emptyLabel}</SelectItem>}</SelectContent></Select>{selected.length ? <div className="flex flex-wrap gap-1">{selected.map((o) => <Badge key={o.value} variant="outline" className="font-normal">{o.label}</Badge>)}</div> : <p className="text-xs text-muted-foreground">{emptyLabel}</p>}</div>; }
function contactListFieldOptions(list) {
  const metadata = list?.metadata || {};
  const importSettings = metadata.csv_import_settings || metadata.csvImportSettings || {};
  const schemaFields = (list?.custom_field_schema || []).map((f) => f?.name).filter(Boolean);
  const metadataSchemaFields = (importSettings.field_schema || importSettings.fieldSchema || []).map((f) => f?.name).filter(Boolean);
  const selectedColumns = importSettings.selected_columns || importSettings.selectedColumns || [];
  const rowDataColumns = list?.row_data_columns || list?.rowDataColumns || [];
  return [...new Set([...schemaFields, ...metadataSchemaFields, ...selectedColumns, ...rowDataColumns].map((field) => String(field || "").trim()).filter(Boolean))];
}
function contactListNumberOptions(list) { const fields = (list?.custom_field_schema || []).filter((f) => (f.type === "phone") || /phone|mobile|number|whatsapp/i.test(f.name || "")).map((f) => f.name).filter(Boolean); return [...new Set(fields)].map((name) => ({ value: name, label: name })); }
function ToggleRow({ label, checked = false, onCheckedChange = () => {} }) { return <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 p-3"><Label className="text-sm font-medium">{label}</Label><Switch checked={checked} onCheckedChange={onCheckedChange} /></div>; }
function SchemaRow({ name, type }) { return <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 px-3 py-2"><div className="min-w-0"><div className="truncate font-mono text-xs">{name}</div><div className="text-[11px] text-muted-foreground">row_data JSONB</div></div><Badge variant="outline" className="font-mono text-[10px]">{type}</Badge></div>; }
function SettingCard({ icon: Icon, title, subtitle, children }) { return <div className="rounded-2xl border bg-background/85 p-4 shadow-sm"><div className="mb-4 flex items-start gap-3"><span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600"><Icon className="h-4 w-4" /></span><div><h3 className="text-sm font-semibold">{title}</h3><p className="text-xs text-muted-foreground">{subtitle}</p></div></div>{children}</div>; }
function ReadinessLine({ label, ok }) { return <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2"><span>{label}</span><Badge variant="outline" className={ok ? statusClass("ready") : statusClass("draft")}>{ok ? "Ready" : "Needs setup"}</Badge></div>; }
function ComingSoonView({ item }) { const Icon = item.icon; return <div className="flex min-h-[520px] items-center justify-center"><div className="max-w-md rounded-3xl border bg-background/85 p-8 text-center shadow-sm"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 to-violet-500/20 text-sky-600"><Icon className="h-7 w-7" /></div><h3 className="mt-5 text-xl font-semibold">{item.label} is staged for Phase 3</h3><p className="mt-2 text-sm text-muted-foreground">The persistent model is ready. Future work can connect this area to dialer execution, audit events, DNC ingestion, and reporting data.</p><Button className="mt-5" variant="outline">View roadmap</Button></div></div>; }
function LoadingState() { return <div className="flex min-h-[520px] items-center justify-center text-muted-foreground"><IconLoader2 className="mr-2 h-5 w-5 animate-spin" />Loading outbound workspace…</div>; }
function ErrorState({ error, onRetry }) { return <div className="flex min-h-[520px] items-center justify-center"><div className="rounded-2xl border bg-background p-6 text-center shadow-sm"><h3 className="font-semibold">Could not load outbound dialer</h3><p className="mt-2 text-sm text-muted-foreground">{error}</p><Button className="mt-4" variant="outline" onClick={onRetry}>Retry</Button></div></div>; }
function Empty({ title: t, description }) { return <div className="rounded-xl border border-dashed p-6 text-center"><h4 className="font-semibold">{t}</h4><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>; }
function readiness(c) { let score = 20; if (c.contact_list_id) score += 25; if (c.attached_form_id) score += 20; if ((c.form_variable_mapping || []).length) score += 20; if (["ready", "running", "completed"].includes(c.status)) score += 15; return Math.min(score, 100); }
