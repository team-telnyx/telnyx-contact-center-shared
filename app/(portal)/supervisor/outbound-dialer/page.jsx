"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconActivity, IconAdjustmentsHorizontal, IconBrandWhatsapp, IconCalendar, IconChartBar, IconCheck, IconChevronDown, IconClockHour4, IconCopy, IconDatabase, IconDots, IconEye, IconFilter, IconForms, IconHeadphones, IconInfoCircle, IconListDetails, IconLoader2, IconMail, IconPhoneCall, IconPhoneOff, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconPlus, IconRefresh, IconReportAnalytics, IconRotateClockwise, IconSettings, IconShieldCheck, IconSparkles, IconStar, IconStarFilled, IconTrash, IconUpload, IconUsers, IconWand, IconWorld, IconX,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";
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
import InteractionDetailsSheet from "@/components/contact-center/InteractionDetailsSheet";
import { SupervisionModal } from "@/components/contact-center/SupervisionModal";
import { CSV_FILTER_OPERATORS, applyCsvImportRules, normalizeCsvImportRules } from "@/lib/outbound-dialer/csv-import-rules";
import { canValidateContactList, campaignContactListTargets, contactListValidationMessage } from "@/lib/outbound-dialer/contact-list-validation";
import { normalizeAttemptControlLimits, normalizeAttemptCount, normalizeGlobalMaxAttempts } from "@/lib/outbound-dialer/attempt-limits";
import { campaignReferenceKindForMode, campaignRequiresQueueTarget, campaignSaveRequirements } from "@/lib/outbound-dialer/campaign-validation";
import { buildDashboardCampaignExpandedStats } from "@/lib/outbound-dialer/dashboard-view-model";
import { attemptReasonCode, attemptStatusReasonLabel, campaignControlState, campaignStatusEventsFromCampaigns, contactRecordHeaderLabel, contactRecordLabel, groupAttemptsByContactRecord, normalizeCampaignExecutionState, singleCampaignSelection } from "@/lib/outbound-dialer/history-view-model";
import { campaignContactProgress, campaignInventoryDisplayState } from "@/lib/outbound-dialer/progress-view-model";
import { normalizeCampaignPriority } from "@/lib/outbound-dialer/agent-campaigns-view-model";
import { shouldShowOutboundLiveCallInUi } from "@/lib/outbound-dialer/live-calls";

const API = "/api/contact-center/outbound-dialer";
const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconChartBar, description: "Live dialer performance" },
  { id: "live-calls", label: "Live Calls", icon: IconActivity, description: "Monitor active campaign calls" },
  { id: "campaigns", label: "Campaigns", icon: IconPhoneCall, description: "Build and tune outreach" },
  { id: "contact-lists", label: "Contact Lists", icon: IconDatabase, description: "Import audiences and fields" },
  { id: "dnc", label: "DNC", icon: IconShieldCheck, description: "Suppression governance" },
  { id: "filters", label: "Filters", icon: IconFilter, description: "Contact-list eligibility rules" },
  { id: "time-sets", label: "Time Sets", icon: IconCalendar, description: "Dialable windows by timezone" },
  { id: "disposition-codes", label: "Disposition codes", icon: IconListDetails, description: "Map wrap-up codes to campaign outcomes" },
  { id: "attempt-controls", label: "Attempt Controls", icon: IconAdjustmentsHorizontal, description: "Caps, cadence, compliance" },
  { id: "reports", label: "History", icon: IconReportAnalytics, description: "Outbound history and analytics" },
  { id: "event-viewer", label: "Event Viewer", icon: IconListDetails, description: "Dialer timeline" },
  { id: "settings", label: "Settings", icon: IconSettings, description: "Workspace defaults" },
];
const OUTBOUND_UI_STATE_STORAGE_KEYS = {
  activeSection: "supervisor.outbound-dialer.activeSection",
  showOnlyActiveDashboardCampaigns: "supervisor.outbound-dialer.showOnlyActiveDashboardCampaigns",
  timeSetEditorView: "supervisor.outbound-dialer.timeSetEditorView",
};
const TIME_SET_EDITOR_VIEWS = ["calendar", "detail"];
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
const AMD_ELIGIBLE_CAMPAIGN_MODES = ["agentless_ai", "agentless_flow", "power", "predictive"];
const AMD_ACTION_OPTIONS = [
  { value: "disconnect", label: "Disconnect" },
  { value: "leave_message", label: "Leave message" },
];
const DEFAULT_AMD_MESSAGE = "Hello, this is a message from Contact Center Services. Please call us back when you are available.";
const emptySchema = { channels: ["voice", "sms", "whatsapp"], campaignModes: ["preview", "progressive", "power", "predictive", "agentless_ai", "agentless_flow"], campaignStatuses: ["draft", "ready", "paused", "running", "stopped", "completed"], handlerTypes: ["queue", "ai_assistant", "call_flow"], contactListStatuses: ["draft", "validating", "validated"], dncListStatuses: ["draft", "active", "paused"], contactFieldTypes: ["text", "boolean", "number", "date", "datetime", "enum", "select", "phone", "email", "first_name", "last_name", "display_name", "company", "url", "currency"], standardContactColumns: [] };
const CSV_CONTACT_MAPPING_GROUPS = [
  { group: "Number", icon: IconPhoneCall, labelClass: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300", iconClass: "text-emerald-600 dark:text-emerald-300", options: ["mobile", "landline", "work", "home", "daytime", "evening"] },
  { group: "Email", icon: IconMail, labelClass: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300", iconClass: "text-sky-600 dark:text-sky-300", options: ["work", "home"] },
  { group: "WhatsApp", icon: IconBrandWhatsapp, labelClass: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", iconClass: "text-emerald-600 dark:text-emerald-300", options: ["work", "home"] },
];
const CSV_CONTACT_MAPPING_PREFIXES = ["number:", "email:", "whatsapp:"];
const FORM_DATA_FIELD_TYPES = new Set(["text", "textarea", "select", "radio", "checkbox", "switch", "slider", "datetime", "hidden"]);
const title = (value) => String(value || "").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\bAi\b/g, "AI");
const statusClass = (status) => {
  const value = String(status || "").toLowerCase();
  if (value === "exhausted") return "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300";
  if (value === "running" || value === "started") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "paused") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (value === "recycled") return "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  if (value === "stopped" || value === "completed") return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  if (["ready", "validated", "active"].includes(value)) return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (["draft", "validating"].includes(value)) return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
  return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
};
const activationBadgeClass = (active) => active ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
const campaignModeClass = (mode) => {
  const value = String(mode || "").toLowerCase();
  if (value === "preview") return "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  if (value === "progressive") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (value === "agentless_ai") return "border-fuchsia-500/35 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300";
  if (value === "agentless_flow") return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (value === "power") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "predictive") return "border-orange-500/35 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
};

const attemptStatusClass = (status) => {
  const value = String(status || "").toLowerCase();
  if (value === "completed") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "failed") return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  if (value === "answered") return "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  if (["dialing", "claimed", "running"].includes(value)) return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return statusClass(status);
};

const defaultCampaign = () => ({ name: "New voice campaign", description: "", status: "draft", channel: "voice", mode: "preview", handler_type: "queue", handler_ref: "", contact_list_id: null, attached_form_id: null, pacing_config: { strategy: "per_available_agent", ratio: 1, supervisorApproval: true }, concurrency_config: { maxConcurrent: 10, maxLines: 10, perAgentLimit: 1 }, dialing_windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00", timezonePolicy: "contact" }], retry_policy: { maxAttempts: 4, delayBetweenAttemptsMinutes: 360, minDelayHours: 6, exhaustAfterDays: 7 }, amd_config: { enabled: true, humanConfidenceThreshold: 0.74, voicemailAction: "hangup" }, form_variable_mapping: [], metadata: { rotate_numbers: false, from_numbers: [] } });
const defaultList = () => ({ name: "New contact list", description: "", status: "draft", source_type: "csv", custom_field_schema: [], record_count: 0, valid_phone_count: 0, metadata: {} });
const defaultDncList = () => ({ name: "New DNC list", description: "", status: "draft", source_type: "csv", match_strategy: "phone", record_count: 0, metadata: {} });
const defaultFilter = () => ({ name: "New contact filter", description: "", status: "draft", contact_list_id: null, conditions: [], metadata: {} });
const defaultCallableDays = () => ["mon", "tue", "wed", "thu", "fri"];
const normalizedCallableDays = (settings) => {
  const days = settings?.callable_days || settings?.callableDays || defaultCallableDays();
  const valid = new Set(WEEKDAYS.map((day) => day.id));
  const normalized = (Array.isArray(days) ? days : []).map((day) => String(day || "").toLowerCase()).filter((day, idx, list) => valid.has(day) && list.indexOf(day) === idx);
  return normalized.length ? normalized : defaultCallableDays();
};
const defaultTimeSetFromSettings = (settings) => {
  const callableWindow = settings?.callable_window || settings?.callableWindow || defaultOutboundSettings().callable_window;
  const callableDays = normalizedCallableDays(settings);
  return { name: "Business hours", description: "", status: "draft", timezone: callableWindow.timezone || "Europe/Warsaw", windows: WEEKDAYS.map((day) => ({ day: day.id, enabled: callableDays.includes(day.id), start: callableWindow.earliest || "09:00", end: callableWindow.latest || "20:00" })), metadata: { view: "detail" } };
};
const defaultAttemptControl = () => ({ name: "Default attempt control", description: "", status: "draft", reset_period: "daily", timezone: "Europe/Warsaw", max_attempts_per_contact: 4, max_attempts_per_number: 2, recall_rules: [{ outcome: "busy", attempts: 1, minutes_between_attempts: 30 }, { outcome: "no_answer", attempts: 1, minutes_between_attempts: 120 }], phone_type_rules: [], metadata: {} });
const defaultOutboundSettings = () => ({ max_calls_per_agent: 1, max_lines: 10, max_line_utilization_percent: 90, max_cps: 50, compliance_abandon_threshold_seconds: 2, global_max_attempts: 5, dial_timeout_secs: 30, callable_days: defaultCallableDays(), callable_window: { earliest: "09:00", latest: "20:00", timezone: "Europe/Warsaw" }, allowed_numbers: [] });
const normalizeDialTimeoutSecs = (value, fallback = 30) => { const parsed = Number(value); if (Number.isFinite(parsed) && parsed > 0) return Math.max(15, Math.min(600, Math.round(parsed))); const fallbackParsed = Number(fallback); if (Number.isFinite(fallbackParsed) && fallbackParsed > 0) return Math.max(15, Math.min(600, Math.round(fallbackParsed))); return 30; };
const RECALL_OUTCOMES = ["busy", "no_answer", "answering_machine", "failed", "abandoned", "fax", "system_error"];
const PHONE_TYPES = ["work", "home", "mobile", "cell", "landline", "whatsapp", "daytime", "evening"];
const WEEKDAYS = [{ id: "mon", label: "Mon" }, { id: "tue", label: "Tue" }, { id: "wed", label: "Wed" }, { id: "thu", label: "Thu" }, { id: "fri", label: "Fri" }, { id: "sat", label: "Sat" }, { id: "sun", label: "Sun" }];
const FALLBACK_TIME_ZONES = ["Europe/Warsaw", "UTC", "Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Prague", "Europe/Vienna", "Europe/Dublin", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Sao_Paulo", "Asia/Dubai", "Asia/Jerusalem", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
const formatUtcOffset = (offsetMinutes) => {
  if (!Number.isFinite(offsetMinutes)) return "UTC offset unavailable";
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
};
const parseShortOffset = (value) => {
  const match = String(value || "").match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return /^(?:GMT|UTC)$/i.test(String(value || "")) ? 0 : null;
  const [, sign, hours, minutes = "0"] = match;
  const parsed = (Number(hours) * 60) + Number(minutes);
  return sign === "-" ? -parsed : parsed;
};
const zonedPartsOffset = (timeZone, date) => {
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - date.getTime()) / 60000);
};
const getTimeZoneOffsetMinutes = (timeZone, date = new Date()) => {
  if (!timeZone) return null;
  if (timeZone === "UTC") return 0;
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") return null;
  try {
    const offsetPart = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(date).find((part) => part.type === "timeZoneName");
    const parsed = parseShortOffset(offsetPart?.value);
    if (parsed !== null) return parsed;
  } catch {
    // Some runtimes support Intl.DateTimeFormat but not the shortOffset token.
  }
  try {
    return zonedPartsOffset(timeZone, date);
  } catch {
    return null;
  }
};
const timeZoneOptionFor = (zone, date = new Date()) => {
  const offsetMinutes = getTimeZoneOffsetMinutes(zone, date);
  const offset = formatUtcOffset(offsetMinutes);
  return { value: zone, label: Number.isFinite(offsetMinutes) ? `${offset} ${zone}` : zone, offset };
};
const calendarStartMinute = 0;
const calendarEndMinute = 24 * 60;
const calendarTotalMinutes = calendarEndMinute - calendarStartMinute;
const calendarSnapMinutes = 15;
const calendarHourHeight = 28;
const calendarViewportHeight = 336;
const calendarGridHeight = (calendarTotalMinutes / 60) * calendarHourHeight;
const nativeTimeMaxMinute = calendarEndMinute - 1;
const clampCalendarMinute = (minutes, max = calendarEndMinute) => Math.max(calendarStartMinute, Math.min(max, minutes));
const timeToMinutes = (value, fallback = calendarStartMinute) => { const [hours, minutes] = String(value || "").split(":").map(Number); return Number.isFinite(hours) ? clampCalendarMinute((hours * 60) + (Number.isFinite(minutes) ? minutes : 0)) : fallback; };
const timeToEndMinutes = (value, fallback = calendarEndMinute) => { const minutes = timeToMinutes(value, fallback); return minutes >= nativeTimeMaxMinute ? calendarEndMinute : minutes; };
const minutesToTime = (minutes) => { const clamped = clampCalendarMinute(Math.floor(Number.isFinite(minutes) ? minutes : calendarStartMinute), nativeTimeMaxMinute); return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`; };
const normalizeNativeTime = (value, fallback = "00:00") => minutesToTime(timeToMinutes(value, timeToMinutes(fallback)));
const normalizeWindowTimes = (timeWindow) => ({ ...timeWindow, start: normalizeNativeTime(timeWindow.start, "09:00"), end: normalizeNativeTime(timeWindow.end, "17:00") });
const api = async (url, options = {}) => { const res = await fetch(url, { cache: "no-store", ...options, headers: options.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) } }); const data = await res.json().catch(() => ({})); if (!res.ok) { const details = data.details ? ` (${typeof data.details === "string" ? data.details : JSON.stringify(data.details)})` : ""; throw new Error(data.error ? `${data.error}${details}` : `Request failed (${res.status})`); } return data; };

const isDashboardCampaign = (campaign) => campaign && !["draft", "design", "archived"].includes(String(campaign.status || "").toLowerCase());
const isActiveCampaignConfig = (campaign) => campaign && !["draft", "design", "archived"].includes(String(campaign.status || "").toLowerCase());
const isActiveConfigItem = (item) => String(item?.status || "").toLowerCase() === "active";
const activeToggleStatusPatch = (checked, activeStatus = "active", inactiveStatus = "draft") => ({ status: checked ? activeStatus : inactiveStatus });
const executionStateFor = normalizeCampaignExecutionState;
const ACTIVE_DASHBOARD_CAMPAIGN_STATES = new Set(["running", "stopped", "paused", "recycled"]);

const campaignLiveMetrics = (campaign, executionDebug = null) => {
  const summary = executionDebug?.summary || {};
  if (executionDebug) {
    const hasMachineMetric = Object.prototype.hasOwnProperty.call(summary, "machine_total");
    const hasNoAnswerMetric = Object.prototype.hasOwnProperty.call(summary, "no_answer_total");
    return {
      active: Number(summary.active_now || 0),
      ringing: Number(summary.dialing_now || 0),
      answered: Number(summary.answered_total || 0),
      hangups: Number(summary.hangups_total || 0),
      failed: Number(summary.failed_total || 0),
      machine: hasMachineMetric ? Number(summary.machine_total || 0) : null,
      noAnswer: hasNoAnswerMetric ? Number(summary.no_answer_total || 0) : null,
    };
  }
  const metrics = campaign?.metadata?.live_metrics || campaign?.metadata?.liveMetrics || campaign?.metadata?.metrics || {};
  const hasMachineMetric = metrics.machine != null || metrics.answering_machine != null || metrics.answeringMachine != null;
  const hasNoAnswerMetric = metrics.no_answer != null || metrics.noAnswer != null;
  return {
    active: Number(metrics.active_calls ?? metrics.activeCalls ?? metrics.active ?? 0) || 0,
    ringing: Number(metrics.ringing ?? 0) || 0,
    answered: Number(metrics.answered ?? 0) || 0,
    hangups: Number(metrics.hangups ?? metrics.hangup ?? metrics.completed ?? 0) || 0,
    failed: Number(metrics.failed ?? 0) || 0,
    machine: hasMachineMetric ? Number(metrics.machine ?? metrics.answering_machine ?? metrics.answeringMachine ?? 0) || 0 : null,
    noAnswer: hasNoAnswerMetric ? Number(metrics.no_answer ?? metrics.noAnswer ?? 0) || 0 : null,
  };
};
const campaignRuntimeContext = (campaign, contactLists = [], executionDebug = null) => ({
  progress: campaignContactProgress(campaign, contactLists, executionDebug),
  live: campaignLiveMetrics(campaign, executionDebug),
});
const executionStateWithRuntimeFor = (campaign, contactLists = [], executionDebug = null) => executionStateFor(campaign, campaignRuntimeContext(campaign, contactLists, executionDebug));
const isActiveDashboardCampaign = (campaign, contactLists = [], executionDebug = null) => ACTIVE_DASHBOARD_CAMPAIGN_STATES.has(executionStateWithRuntimeFor(campaign, contactLists, executionDebug));
const campaignTimeline = (campaign) => {
  const events = campaign?.metadata?.event_timeline || campaign?.metadata?.eventTimeline || campaign?.metadata?.events || [];
  return Array.isArray(events) ? events.slice(0, 5) : [];
};
const normalizeReasonCodeLabel = (value) => title(String(value || "unknown").replace(/\./g, "_"));
const formatPercent = (value) => `${Math.round(Number(value || 0))}%`;
const formatDuration = (seconds = 0) => { const safe = Math.max(0, Math.floor(Number(seconds) || 0)); const h = Math.floor(safe / 3600); const m = Math.floor((safe % 3600) / 60); const s = safe % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`; };
const liveCallStatusClass = (status) => ({ ringing: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300", connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", hangup: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300", failed: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300" }[String(status || "").toLowerCase()] || statusClass(status));
const liveCallBadgeLabel = (call = {}) => call.status_reason_label || title(call.status);
const liveCallBadgeClass = (call = {}) => call.status === "hangup" && call.status_reason_label ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : liveCallStatusClass(call.status);
const classifyReasonCode = (reasonCode, retryEligibleCount) => {
  if (Number(retryEligibleCount || 0) > 0) return "retryable";
  const value = String(reasonCode || "").toLowerCase();
  if (["originator_cancel", "rejected", "blocked", "do_not_call", "suppressed", "cancelled"].includes(value)) return "cancelled";
  return "completed";
};
const reasonCodeToneClass = (bucket) => bucket === "retryable"
  ? "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  : bucket === "cancelled"
    ? "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300"
    : "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
const keepSelectedRecord = (items) => (currentId) => (currentId && items.some((item) => item.id === currentId) ? currentId : items[0]?.id || null);
const outboundToastName = (record, fallback) => String(record?.name || fallback || "This item").trim();
const campaignToastDescription = (campaign, action) => `Campaign ${outboundToastName(campaign, "campaign")} has been successfully ${action}.`;
const outboundToastDescription = (record, label, action) => `${label} ${outboundToastName(record, label.toLowerCase())} has been successfully ${action}.`;

export default function OutboundDialerPage() {
  const router = useRouter();
  const [active, setActive] = useState("dashboard");
  const [campaigns, setCampaigns] = useState([]); const [contactLists, setContactLists] = useState([]); const [dncLists, setDncLists] = useState([]); const [filters, setFilters] = useState([]); const [timeSets, setTimeSets] = useState([]); const [dispositionCodes, setDispositionCodes] = useState([]); const [wrapupCodes, setWrapupCodes] = useState([]); const [attemptControls, setAttemptControls] = useState([]); const [outboundSettings, setOutboundSettings] = useState(defaultOutboundSettings()); const [inventoryNumbers, setInventoryNumbers] = useState([]); const [executionDebugByCampaign, setExecutionDebugByCampaign] = useState({}); const [forms, setForms] = useState([]); const [handlerReferences, setHandlerReferences] = useState({ queue: [], call_flow: [], workflow: [], ai_assistant: [] }); const [schema, setSchema] = useState(emptySchema);
  const [selectedCampaignId, setSelectedCampaignId] = useState(null); const [selectedListId, setSelectedListId] = useState(null); const [selectedDncId, setSelectedDncId] = useState(null); const [selectedFilterId, setSelectedFilterId] = useState(null); const [selectedTimeSetId, setSelectedTimeSetId] = useState(null); const [selectedDispositionCodeId, setSelectedDispositionCodeId] = useState(null); const [selectedAttemptControlId, setSelectedAttemptControlId] = useState(null); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState(null);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [headerSaveAction, setHeaderSaveAction] = useState(null);
  const [campaignReasonMetrics, setCampaignReasonMetrics] = useState({});
  const [reasonMetricsLoading, setReasonMetricsLoading] = useState(false);
  const [selectedReasonMetricsDay, setSelectedReasonMetricsDay] = useState(null);
  const [selectedReasonMetricsCampaignId, setSelectedReasonMetricsCampaignId] = useState(null);
  const [eventViewerCampaignId, setEventViewerCampaignId] = useState(null);
  const [eventViewerType, setEventViewerType] = useState("all");
  const [liveCallsPayload, setLiveCallsPayload] = useState({ calls: [], totals: { total: 0, active: 0, byStatus: {} }, filters: { campaigns: [], statuses: [] } });
  const [liveCallsLoading, setLiveCallsLoading] = useState(false);
  const [liveCampaignFilter, setLiveCampaignFilter] = useState("all");
  const [liveStatusFilter, setLiveStatusFilter] = useState("all");
  const [showDisconnectedLiveCalls, setShowDisconnectedLiveCalls] = useState(true);
  const [showOnlyActiveDashboardCampaigns, setShowOnlyActiveDashboardCampaigns] = useState(false);
  const [timeSetEditorView, setTimeSetEditorView] = useState("calendar");
  const [selectedLiveCallDetails, setSelectedLiveCallDetails] = useState(null);
  const [selectedSupervisionCall, setSelectedSupervisionCall] = useState(null);
  const outboundUiStateHydratedRef = useRef(false);
  const activeMeta = useMemo(() => NAV_ITEMS.find((item) => item.id === active) || NAV_ITEMS[0], [active]);
  const selectedCampaign = useMemo(() => campaigns.find((c) => c.id === selectedCampaignId) || campaigns[0] || null, [campaigns, selectedCampaignId]);
  const dashboardCampaigns = useMemo(() => campaigns.filter(isDashboardCampaign), [campaigns]);
  const selectableDashboardCampaigns = useMemo(() => showOnlyActiveDashboardCampaigns ? dashboardCampaigns.filter((campaign) => isActiveDashboardCampaign(campaign, contactLists, executionDebugByCampaign?.[campaign.id])) : dashboardCampaigns, [contactLists, dashboardCampaigns, executionDebugByCampaign, showOnlyActiveDashboardCampaigns]);
  const selectedDashboardCampaign = useMemo(() => selectableDashboardCampaigns.find((c) => c.id === selectedCampaignId) || selectableDashboardCampaigns[0] || null, [selectableDashboardCampaigns, selectedCampaignId]);
  const effectiveSelectedReasonMetricsDay = selectedReasonMetricsCampaignId === selectedDashboardCampaign?.id ? selectedReasonMetricsDay : null;
  const selectedList = useMemo(() => contactLists.find((l) => l.id === selectedListId) || contactLists[0] || null, [contactLists, selectedListId]);
  const selectedDncList = useMemo(() => dncLists.find((l) => l.id === selectedDncId) || dncLists[0] || null, [dncLists, selectedDncId]);
  const selectedFilter = useMemo(() => filters.find((f) => f.id === selectedFilterId) || filters[0] || null, [filters, selectedFilterId]);
  const selectedTimeSet = useMemo(() => timeSets.find((t) => t.id === selectedTimeSetId) || timeSets[0] || null, [timeSets, selectedTimeSetId]);
  const selectedDispositionCode = useMemo(() => dispositionCodes.find((d) => d.id === selectedDispositionCodeId) || dispositionCodes[0] || null, [dispositionCodes, selectedDispositionCodeId]);
  const selectedAttemptControl = useMemo(() => attemptControls.find((a) => a.id === selectedAttemptControlId) || attemptControls[0] || null, [attemptControls, selectedAttemptControlId]);
  const refresh = useCallback(async (toast = false) => { if (!isAuthorized) return; try { setLoading(true); setError(null); const [data, dispositionData] = await Promise.all([api(API), api(`${API}/disposition-codes`).catch(() => ({ dispositionCodes: [], wrapupCodes: [] }))]); const nextCampaigns = data.campaigns || []; const nextContactLists = data.contactLists || []; const nextDncLists = data.dncLists || []; const nextFilters = data.filters || []; const nextTimeSets = data.timeSets || []; const nextDispositionCodes = dispositionData.dispositionCodes || []; const nextWrapupCodes = dispositionData.wrapupCodes || []; const nextAttemptControls = data.attemptControls || []; setCampaigns(nextCampaigns); setContactLists(nextContactLists); setDncLists(nextDncLists); setFilters(nextFilters); setTimeSets(nextTimeSets); setDispositionCodes(nextDispositionCodes); setWrapupCodes(nextWrapupCodes); setAttemptControls(nextAttemptControls); setOutboundSettings(data.settings || defaultOutboundSettings()); setInventoryNumbers(data.inventoryNumbers || []); setExecutionDebugByCampaign(data.executionDebugByCampaign || {}); setForms(data.forms || []); setHandlerReferences(data.handlerReferences || { queue: [], call_flow: [], workflow: [], ai_assistant: [] }); setSchema(data.schema || emptySchema); setSelectedCampaignId(keepSelectedRecord(nextCampaigns)); setSelectedListId(keepSelectedRecord(nextContactLists)); setSelectedDncId(keepSelectedRecord(nextDncLists)); setSelectedFilterId(keepSelectedRecord(nextFilters)); setSelectedTimeSetId(keepSelectedRecord(nextTimeSets)); setSelectedDispositionCodeId(keepSelectedRecord(nextDispositionCodes)); setSelectedAttemptControlId(keepSelectedRecord(nextAttemptControls)); if (toast) notify({ title: "Outbound dialer refreshed", description: "Outbound dialer data has been successfully refreshed.", variant: "success" }); } catch (err) { setError(err.message); notify({ title: "Failed to load outbound dialer", description: err.message, variant: "error" }); } finally { setLoading(false); } }, [isAuthorized]);
  useEffect(() => {
    try {
      const savedActive = localStorage.getItem(OUTBOUND_UI_STATE_STORAGE_KEYS.activeSection);
      if (savedActive && NAV_ITEMS.some((item) => item.id === savedActive)) setActive(savedActive);
      const savedShowOnlyRunning = localStorage.getItem(OUTBOUND_UI_STATE_STORAGE_KEYS.showOnlyActiveDashboardCampaigns);
      if (savedShowOnlyRunning === "true" || savedShowOnlyRunning === "false") setShowOnlyActiveDashboardCampaigns(savedShowOnlyRunning === "true");
      const savedTimeSetEditorView = localStorage.getItem(OUTBOUND_UI_STATE_STORAGE_KEYS.timeSetEditorView);
      if (TIME_SET_EDITOR_VIEWS.includes(savedTimeSetEditorView)) setTimeSetEditorView(savedTimeSetEditorView);
    } catch {
      // Ignore storage errors so supervisor screens still load in locked-down browsers.
    } finally {
      window.setTimeout(() => { outboundUiStateHydratedRef.current = true; }, 0);
    }
  }, []);
  useEffect(() => {
    if (!outboundUiStateHydratedRef.current) return;
    try { localStorage.setItem(OUTBOUND_UI_STATE_STORAGE_KEYS.activeSection, active); } catch {}
  }, [active]);
  useEffect(() => {
    if (!outboundUiStateHydratedRef.current) return;
    try { localStorage.setItem(OUTBOUND_UI_STATE_STORAGE_KEYS.showOnlyActiveDashboardCampaigns, String(showOnlyActiveDashboardCampaigns)); } catch {}
  }, [showOnlyActiveDashboardCampaigns]);
  useEffect(() => {
    if (!outboundUiStateHydratedRef.current) return;
    try { localStorage.setItem(OUTBOUND_UI_STATE_STORAGE_KEYS.timeSetEditorView, timeSetEditorView); } catch {}
  }, [timeSetEditorView]);
  useEffect(() => {
    let cancelled = false;
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!data?.isAuth || !data?.user) {
          router.push("/signin");
          return;
        }
        const userRoles = Array.isArray(data.user.roles) && data.user.roles.length > 0
          ? data.user.roles.map((role) => String(role).toLowerCase())
          : ["agent"];
        if (!userRoles.includes("owner")) {
          notify({ title: "Access Denied", description: "Only owners can access the outbound dialer.", variant: "error" });
          router.push("/");
          return;
        }
        if (!cancelled) setIsAuthorized(true);
      } catch {
        router.push("/signin");
      } finally {
        if (!cancelled) setCheckingAuth(false);
      }
    }
    checkAuth();
    return () => { cancelled = true; };
  }, [router]);
  useEffect(() => { if (isAuthorized) refresh(); }, [isAuthorized, refresh]);
  useEffect(() => {
    if (!isAuthorized || active !== "dashboard") return;

    let eventSource = null;
    let pollTimer = null;
    let fallbackEnabled = false;

    const applyPayload = (payload) => {
      if (!payload || typeof payload !== "object") return;
      if (Array.isArray(payload.campaigns)) {
        setCampaigns(payload.campaigns);
        setSelectedCampaignId(keepSelectedRecord(payload.campaigns));
      }
      if (Array.isArray(payload.contactLists)) {
        setContactLists(payload.contactLists);
      }
      if (payload.executionDebugByCampaign && typeof payload.executionDebugByCampaign === "object") {
        setExecutionDebugByCampaign(payload.executionDebugByCampaign);
      }
    };

    const enablePollingFallback = () => {
      if (fallbackEnabled) return;
      fallbackEnabled = true;
      pollTimer = setInterval(async () => {
        try {
          const data = await api(`${API}`);
          applyPayload(data);
        } catch {
          // ignore intermittent polling errors
        }
      }, 5000);
    };

    const disablePollingFallback = () => {
      fallbackEnabled = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    try {
      eventSource = new EventSource(`${API}/stream`);
      eventSource.onopen = () => {
        disablePollingFallback();
      };
      eventSource.addEventListener("outbound_update", (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          applyPayload(payload);
        } catch {
          // ignore malformed payloads
        }
      });
      eventSource.onerror = () => {
        enablePollingFallback();
      };
    } catch {
      enablePollingFallback();
    }

    return () => {
      if (pollTimer) clearInterval(pollTimer);
      try { eventSource?.close(); } catch {}
    };
  }, [active, isAuthorized]);

  useEffect(() => {
    if (!isAuthorized || active !== "live-calls") return;
    let cancelled = false;
    let eventSource = null;
    let fallbackTimer = null;
    const applyPayload = (data) => {
      if (!cancelled && data?.calls) setLiveCallsPayload(data);
    };
    const loadLiveCalls = async (showSpinner = false) => {
      try {
        if (showSpinner) setLiveCallsLoading(true);
        applyPayload(await api(`${API}/live-calls`));
      } catch (err) {
        if (!cancelled) notify({ title: "Live calls refresh failed", description: err.message, variant: "error" });
      } finally {
        if (!cancelled) setLiveCallsLoading(false);
      }
    };
    const startPollingFallback = () => {
      if (cancelled || fallbackTimer) return;
      loadLiveCalls(true);
      fallbackTimer = setInterval(() => loadLiveCalls(false), 2000);
    };
    const stopPollingFallback = () => {
      if (!fallbackTimer) return;
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    };
    if (typeof window !== "undefined" && "EventSource" in window) {
      setLiveCallsLoading(true);
      eventSource = new EventSource(`${API}/live-calls/stream`);
      eventSource.addEventListener("open", () => {
        stopPollingFallback();
      });
      eventSource.addEventListener("live_calls", (event) => {
        try {
          stopPollingFallback();
          applyPayload(JSON.parse(event.data));
          setLiveCallsLoading(false);
        } catch (err) {
          notify({ title: "Live calls stream parse failed", description: err.message, variant: "error" });
        }
      });
      eventSource.addEventListener("error", () => {
        if (!cancelled) setLiveCallsLoading(false);
        startPollingFallback();
      });
    } else {
      startPollingFallback();
    }
    return () => {
      cancelled = true;
      if (eventSource) eventSource.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
    };
  }, [active, isAuthorized]);

  useEffect(() => {
    if (active !== "dashboard") return;
    if (!selectedDashboardCampaign?.id) return;
    const selectedCampaignIsDashboard = dashboardCampaigns.some((campaign) => campaign.id === selectedCampaignId);
    const selectedCampaignIsSelectable = selectableDashboardCampaigns.some((campaign) => campaign.id === selectedCampaignId);
    if (!selectedCampaignIsDashboard || selectedCampaignIsSelectable) return;
    setSelectedCampaignId(selectedDashboardCampaign.id);
  }, [active, dashboardCampaigns, selectableDashboardCampaigns, selectedCampaignId, selectedDashboardCampaign?.id]);

  useEffect(() => {
    setSelectedReasonMetricsDay(null);
    setSelectedReasonMetricsCampaignId(selectedDashboardCampaign?.id || null);
  }, [selectedDashboardCampaign?.id]);

  useEffect(() => {
    if (!isAuthorized || active !== "dashboard") return;
    if (!selectedDashboardCampaign?.id) return;
    const cacheKey = `${selectedDashboardCampaign.id}:${effectiveSelectedReasonMetricsDay || "all"}`;
    if (Object.prototype.hasOwnProperty.call(campaignReasonMetrics, cacheKey)) {
      setReasonMetricsLoading(false);
      return;
    }
    let cancelled = false;
    setReasonMetricsLoading(true);
    api(`${API}/campaigns/${selectedDashboardCampaign.id}${effectiveSelectedReasonMetricsDay ? `?day=${encodeURIComponent(effectiveSelectedReasonMetricsDay)}` : ""}`)
      .then((data) => {
        if (cancelled) return;
        setCampaignReasonMetrics((current) => ({
          ...current,
          [cacheKey]: data?.reason_code_metrics || null,
        }));
      })
      .catch(() => {
        // Do not cache transient failures; allow a later render/selection to retry.
      })
      .finally(() => {
        if (cancelled) return;
        setReasonMetricsLoading(false);
      });
    return () => { cancelled = true; };
  }, [active, isAuthorized, selectedDashboardCampaign?.id, campaignReasonMetrics, effectiveSelectedReasonMetricsDay]);

  const selectReasonMetricsDay = useCallback((day) => {
    setSelectedReasonMetricsCampaignId(selectedDashboardCampaign?.id || null);
    setSelectedReasonMetricsDay(day);
  }, [selectedDashboardCampaign?.id]);

  const saveCampaign = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/campaigns/${draft.id}` : `${API}/campaigns`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setCampaigns((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.campaign } : i) : [data.campaign, ...items]); setSelectedCampaignId(data.campaign.id); notify({ title: draft.id ? "Campaign saved" : "Campaign created", description: campaignToastDescription(data.campaign || draft, draft.id ? "saved" : "created"), variant: "success" }); return data.campaign; } catch (err) { notify({ title: "Campaign save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const runCampaignAction = async (campaign, action) => {
    if (!campaign?.id) return;
    setSaving(true);
    try {
      if (["start", "pause", "resume", "stop", "recycle"].includes(action)) {
        const data = await api(`${API}/campaigns/${campaign.id}/execution`, {
          method: "POST",
          body: JSON.stringify({ action }),
        });
        if (data?.campaign) {
          setCampaigns((items) => items.map((i) => i.id === campaign.id ? { ...i, ...data.campaign } : i));
        }
        setSelectedCampaignId(campaign.id);
        notify({
          title: action === "recycle" ? "Campaign recycled" : `Campaign ${action}`,
          description: action === "recycle"
            ? `Requalified records: ${Number(data?.recycled_attempts || 0).toLocaleString()}`
            : (data?.runner?.running ? "Execution worker running." : "Execution state updated."),
          variant: "success",
        });
      }
    } catch (err) {
      notify({ title: "Campaign control failed", description: err.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  };
  const saveList = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/contact-lists/${draft.id}` : `${API}/contact-lists`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setContactLists((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.contactList } : i) : [data.contactList, ...items]); setSelectedListId(data.contactList.id); notify({ title: draft.id ? "Contact list saved" : "Contact list created", description: outboundToastDescription(data.contactList || draft, "Contact list", draft.id ? "saved" : "created"), variant: "success" }); return data.contactList; } catch (err) { notify({ title: "Contact list save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const saveDncList = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/dnc-lists/${draft.id}` : `${API}/dnc-lists`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setDncLists((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.dncList } : i) : [data.dncList, ...items]); setSelectedDncId(data.dncList.id); notify({ title: draft.id ? "DNC list saved" : "DNC list created", description: outboundToastDescription(data.dncList || draft, "DNC list", draft.id ? "saved" : "created"), variant: "success" }); return data.dncList; } catch (err) { notify({ title: "DNC save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const saveFilter = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/filters/${draft.id}` : `${API}/filters`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setFilters((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.filter } : i) : [data.filter, ...items]); setSelectedFilterId(data.filter.id); notify({ title: draft.id ? "Filter saved" : "Filter created", description: outboundToastDescription(data.filter || draft, "Filter", draft.id ? "saved" : "created"), variant: "success" }); return data.filter; } catch (err) { notify({ title: "Filter save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const saveTimeSet = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/time-sets/${draft.id}` : `${API}/time-sets`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setTimeSets((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.timeSet } : i) : [data.timeSet, ...items]); setSelectedTimeSetId(data.timeSet.id); notify({ title: draft.id ? "Time set saved" : "Time set created", description: outboundToastDescription(data.timeSet || draft, "Time set", draft.id ? "saved" : "created"), variant: "success" }); return data.timeSet; } catch (err) { notify({ title: "Time set save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const saveDispositionCode = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/disposition-codes/${draft.id}` : `${API}/disposition-codes`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setDispositionCodes((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.dispositionCode } : i) : [data.dispositionCode, ...items]); setSelectedDispositionCodeId(data.dispositionCode.id); notify({ title: draft.id ? "Disposition mapping saved" : "Disposition mapping created", description: outboundToastDescription(data.dispositionCode || draft, "Disposition mapping", draft.id ? "saved" : "created"), variant: "success" }); return data.dispositionCode; } catch (err) { notify({ title: "Disposition mapping save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const saveAttemptControl = useCallback(async (draft) => { setSaving(true); try { const data = await api(draft.id ? `${API}/attempt-controls/${draft.id}` : `${API}/attempt-controls`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) }); setAttemptControls((items) => draft.id ? items.map((i) => i.id === draft.id ? { ...i, ...data.attemptControl } : i) : [data.attemptControl, ...items]); setSelectedAttemptControlId(data.attemptControl.id); notify({ title: draft.id ? "Attempt control saved" : "Attempt control created", description: outboundToastDescription(data.attemptControl || draft, "Attempt control", draft.id ? "saved" : "created"), variant: "success" }); return data.attemptControl; } catch (err) { notify({ title: "Attempt control save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const saveOutboundSettings = useCallback(async (draft) => { setSaving(true); try { const data = await api(`${API}/settings`, { method: "PUT", body: JSON.stringify(draft) }); setOutboundSettings(data.settings || defaultOutboundSettings()); notify({ title: "Outbound settings saved", description: "Outbound dialer settings have been successfully saved.", variant: "success" }); return data.settings; } catch (err) { notify({ title: "Settings save failed", description: err.message, variant: "error" }); return null; } finally { setSaving(false); } }, []);
  const archive = async (kind, item) => { if (!item?.id) return; setSaving(true); try { const path = kind === "campaign" ? "campaigns" : kind === "dnc" ? "dnc-lists" : kind === "filter" ? "filters" : kind === "time-set" ? "time-sets" : kind === "disposition-code" ? "disposition-codes" : kind === "attempt-control" ? "attempt-controls" : "contact-lists"; await api(`${API}/${path}/${item.id}`, { method: "DELETE" }); if (kind === "campaign") setCampaigns((xs) => xs.filter((x) => x.id !== item.id)); else if (kind === "dnc") setDncLists((xs) => xs.filter((x) => x.id !== item.id)); else if (kind === "filter") setFilters((xs) => xs.filter((x) => x.id !== item.id)); else if (kind === "time-set") setTimeSets((xs) => xs.filter((x) => x.id !== item.id)); else if (kind === "disposition-code") setDispositionCodes((xs) => xs.filter((x) => x.id !== item.id)); else if (kind === "attempt-control") setAttemptControls((xs) => xs.filter((x) => x.id !== item.id)); else setContactLists((xs) => xs.filter((x) => x.id !== item.id)); notify({ title: `${kind === "campaign" ? "Campaign" : kind === "dnc" ? "DNC list" : kind === "filter" ? "Filter" : kind === "time-set" ? "Time set" : kind === "disposition-code" ? "Disposition mapping" : kind === "attempt-control" ? "Attempt control" : "Contact list"} archived`, description: outboundToastDescription(item, kind === "campaign" ? "Campaign" : kind === "dnc" ? "DNC list" : kind === "filter" ? "Filter" : kind === "time-set" ? "Time set" : kind === "disposition-code" ? "Disposition mapping" : kind === "attempt-control" ? "Attempt control" : "Contact list", "archived"), variant: "success" }); } catch (err) { notify({ title: "Archive failed", description: err.message, variant: "error" }); } finally { setSaving(false); } };

  const eventViewerSelection = useMemo(() => singleCampaignSelection(campaigns, eventViewerCampaignId), [campaigns, eventViewerCampaignId]);
  const effectiveEventViewerCampaignId = eventViewerSelection.id;
  useEffect(() => {
    if (eventViewerCampaignId !== effectiveEventViewerCampaignId) setEventViewerCampaignId(effectiveEventViewerCampaignId);
  }, [eventViewerCampaignId, effectiveEventViewerCampaignId]);
  const eventViewerTypes = useMemo(() => ["all", ...new Set(outboundEventsFromCampaigns(campaigns, executionDebugByCampaign).filter((event) => !effectiveEventViewerCampaignId || event.campaign_id === effectiveEventViewerCampaignId).map((event) => event.type).filter(Boolean))], [campaigns, executionDebugByCampaign, effectiveEventViewerCampaignId]);
  const validatedContactLists = useMemo(() => campaignContactListTargets(contactLists), [contactLists]);
  const activeDncLists = useMemo(() => dncLists.filter(isActiveConfigItem), [dncLists]);
  const activeFilters = useMemo(() => filters.filter(isActiveConfigItem), [filters]);
  const activeTimeSets = useMemo(() => timeSets.filter(isActiveConfigItem), [timeSets]);
  const activeAttemptControls = useMemo(() => attemptControls.filter(isActiveConfigItem), [attemptControls]);
  const headerAction = { campaigns: { label: "New campaign", create: () => { setActive("campaigns"); saveCampaign(defaultCampaign()); } }, "contact-lists": { label: "New contact list", create: () => { setActive("contact-lists"); saveList(defaultList()); } }, dnc: { label: "New DNC list", create: () => { setActive("dnc"); saveDncList(defaultDncList()); } }, filters: { label: "New filter", create: () => { setActive("filters"); saveFilter(defaultFilter()); } }, "time-sets": { label: "New time set", create: () => { setActive("time-sets"); saveTimeSet(defaultTimeSetFromSettings(outboundSettings)); } }, "disposition-codes": { label: "New disposition mapping", create: () => { setActive("disposition-codes"); saveDispositionCode(defaultDispositionCode(wrapupCodes)); } }, "attempt-controls": { label: "New attempt control", create: () => { setActive("attempt-controls"); saveAttemptControl(defaultAttemptControl()); } }, "live-calls": { label: null, create: null }, settings: { label: null, create: null } }[active];
  const registerHeaderSaveAction = useCallback((action) => setHeaderSaveAction(action), []);
  const activeSaveAction = headerSaveAction?.section === active ? headerSaveAction : null;

  if (checkingAuth || !isAuthorized) return <SupervisorPageShell className={supervisorPurplePageShellClass}><LoadingState /></SupervisorPageShell>;

  return <SupervisorPageShell className={supervisorPurplePageShellClass}>
    <SupervisorPageHeader
      title="Outbound Dialer"
      actions={headerAction ? <><Button variant="outline" size="sm" onClick={() => refresh(true)} disabled={loading}><IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>{activeSaveAction ? <Button size="sm" className={neutralActionClass} onClick={activeSaveAction.onSave} disabled={activeSaveAction.disabled}>{activeSaveAction.busy ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconCheck className="mr-2 h-4 w-4" />}{activeSaveAction.label}</Button> : null}{headerAction.create ? <Button size="sm" className={neutralActionClass} onClick={headerAction.create} disabled={saving}><IconWand className="mr-2 h-4 w-4" />{headerAction.label}</Button> : null}</> : null}
    />
    <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr) 380px` }}>
      <SectionRail items={NAV_ITEMS} activeId={active} onSelect={setActive} ariaLabel="Outbound dialer sections" />
      <section className="min-h-0 overflow-hidden rounded-2xl border bg-card/95 shadow-sm backdrop-blur flex flex-col"><div className="h-16 shrink-0 border-b bg-card/95 px-5 flex items-center justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold">{activeMeta.label}</h2><p className="text-xs text-muted-foreground">{activeMeta.description}</p></div></div><div className="flex-1 min-h-0 overflow-y-auto p-5">{loading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={() => refresh()} /> : active === "dashboard" ? <DashboardView campaigns={campaigns} contactLists={contactLists} executionDebugByCampaign={executionDebugByCampaign} selectedCampaignId={selectedDashboardCampaign?.id} setSelectedCampaignId={setSelectedCampaignId} runCampaignAction={runCampaignAction} saving={saving} showOnlyActiveCampaigns={showOnlyActiveDashboardCampaigns} setShowOnlyActiveCampaigns={setShowOnlyActiveDashboardCampaigns} /> : active === "live-calls" ? <LiveCallsView payload={liveCallsPayload} loading={liveCallsLoading} campaignFilter={liveCampaignFilter} statusFilter={liveStatusFilter} showDisconnectedCalls={showDisconnectedLiveCalls} onOpenDetails={setSelectedLiveCallDetails} onOpenSupervision={setSelectedSupervisionCall} /> : active === "campaigns" ? <CampaignsView campaigns={campaigns} contactLists={contactLists} executionDebugByCampaign={executionDebugByCampaign} selectedCampaign={selectedCampaign} setSelectedCampaignId={setSelectedCampaignId} archive={(item) => archive("campaign", item)} saving={saving} /> : active === "contact-lists" ? <ContactListsView contactLists={contactLists} selectedList={selectedList} setSelectedListId={setSelectedListId} archive={(item) => archive("list", item)} saving={saving} /> : active === "dnc" ? <DncListsView dncLists={dncLists} selectedDncList={selectedDncList} setSelectedDncId={setSelectedDncId} archive={(item) => archive("dnc", item)} saving={saving} /> : active === "filters" ? <FiltersView filters={filters} selectedFilter={selectedFilter} setSelectedFilterId={setSelectedFilterId} archive={(item) => archive("filter", item)} saving={saving} /> : active === "time-sets" ? <TimeSetsView timeSets={timeSets} selectedTimeSet={selectedTimeSet} setSelectedTimeSetId={setSelectedTimeSetId} archive={(item) => archive("time-set", item)} saving={saving} /> : active === "disposition-codes" ? <DispositionCodesView dispositionCodes={dispositionCodes} selectedDispositionCode={selectedDispositionCode} setSelectedDispositionCodeId={setSelectedDispositionCodeId} archive={(item) => archive("disposition-code", item)} saving={saving} /> : active === "attempt-controls" ? <AttemptControlsView attemptControls={attemptControls} selectedAttemptControl={selectedAttemptControl} setSelectedAttemptControlId={setSelectedAttemptControlId} archive={(item) => archive("attempt-control", item)} saving={saving} /> : active === "reports" ? <ReportsView campaigns={campaigns} contactLists={contactLists} dncLists={dncLists} executionDebugByCampaign={executionDebugByCampaign} selectedCampaignId={selectedCampaignId} setSelectedCampaignId={setSelectedCampaignId} /> : active === "event-viewer" ? <EventViewerView campaigns={campaigns} executionDebugByCampaign={executionDebugByCampaign} campaignId={effectiveEventViewerCampaignId} typeFilter={eventViewerType} /> : active === "settings" ? <SettingsSummaryView settings={outboundSettings} /> : <ComingSoonView item={activeMeta} />}</div></section>
      <aside className="min-h-0 overflow-hidden rounded-2xl border bg-card/92 shadow-sm backdrop-blur flex flex-col"><PanelHeader title={active === "dashboard" ? "Campaign monitor" : active === "live-calls" ? "Live call filters" : "Context settings"} description={active === "dashboard" ? "Execution status details" : active === "live-calls" ? "Realtime totals and filters" : `${activeMeta.label} configuration`} /><SettingsPanel active={active} campaigns={campaigns} campaign={active === "dashboard" ? selectedDashboardCampaign : selectedCampaign} contactList={selectedList} dncList={selectedDncList} filter={selectedFilter} timeSet={selectedTimeSet} dispositionCode={selectedDispositionCode} wrapupCodes={wrapupCodes} attemptControl={selectedAttemptControl} outboundSettings={outboundSettings} inventoryNumbers={inventoryNumbers} forms={forms} contactLists={active === "campaigns" ? validatedContactLists : contactLists} dncLists={active === "campaigns" ? activeDncLists : dncLists} filters={active === "campaigns" ? activeFilters : filters} timeSets={active === "campaigns" ? activeTimeSets : timeSets} attemptControls={active === "campaigns" ? activeAttemptControls : attemptControls} handlerReferences={handlerReferences} schema={schema} saveCampaign={saveCampaign} saveList={saveList} saveDncList={saveDncList} saveFilter={saveFilter} saveTimeSet={saveTimeSet} saveDispositionCode={saveDispositionCode} saveAttemptControl={saveAttemptControl} saveOutboundSettings={saveOutboundSettings} saving={saving} onImported={refresh} registerHeaderSaveAction={registerHeaderSaveAction} reasonMetrics={campaignReasonMetrics[`${selectedDashboardCampaign?.id || ""}:${effectiveSelectedReasonMetricsDay || "all"}`] || null} reasonMetricsLoading={reasonMetricsLoading} selectedReasonDay={effectiveSelectedReasonMetricsDay} onSelectReasonDay={selectReasonMetricsDay} executionDebug={selectedDashboardCampaign?.id ? executionDebugByCampaign[selectedDashboardCampaign.id] : null} eventViewerCampaignId={effectiveEventViewerCampaignId} setEventViewerCampaignId={setEventViewerCampaignId} selectedCampaignId={selectedCampaignId} setSelectedCampaignId={setSelectedCampaignId} eventViewerType={eventViewerType} setEventViewerType={setEventViewerType} eventViewerTypes={eventViewerTypes} executionDebugByCampaign={executionDebugByCampaign} liveCallsPayload={liveCallsPayload} liveCampaignFilter={liveCampaignFilter} setLiveCampaignFilter={setLiveCampaignFilter} liveStatusFilter={liveStatusFilter} setLiveStatusFilter={setLiveStatusFilter} showDisconnectedLiveCalls={showDisconnectedLiveCalls} setShowDisconnectedLiveCalls={setShowDisconnectedLiveCalls} timeSetEditorView={timeSetEditorView} setTimeSetEditorView={setTimeSetEditorView} /></aside>
    </main><InteractionDetailsSheet open={Boolean(selectedLiveCallDetails)} onOpenChange={(open) => { if (!open) setSelectedLiveCallDetails(null); }} interaction={selectedLiveCallDetails?.sessionDetails || null} /><SupervisionModal open={Boolean(selectedSupervisionCall)} onOpenChange={(open) => { if (!open) setSelectedSupervisionCall(null); }} call={selectedSupervisionCall?.supervisionCall || null} /></SupervisorPageShell>;
}


function LiveCallsView({ payload, loading, campaignFilter, statusFilter, showDisconnectedCalls, onOpenDetails, onOpenSupervision }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const calls = useMemo(() => (payload?.calls || []).filter((call) => (campaignFilter === "all" || call.campaign_id === campaignFilter) && (statusFilter === "all" || call.status === statusFilter) && shouldShowOutboundLiveCallInUi(call, { now, showDisconnectedCalls })), [payload, campaignFilter, statusFilter, showDisconnectedCalls, now]);
  return <div className="space-y-3">{loading ? <div className="rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">Refreshing live calls…</div> : null}{calls.length ? calls.map((call) => <LiveCallCard key={call.id} call={call} now={now} onOpenDetails={() => onOpenDetails(call)} onOpenSupervision={() => onOpenSupervision(call)} />) : <Empty title="No live calls" description="Active campaign calls will appear here when they start ringing, connect, or hang up within the last 60 seconds." />}</div>;
}

async function copyLiveCallValue(value, label) {
  const text = String(value || "").trim();
  if (!text) return;
  try {
    if (!navigator?.clipboard?.writeText) throw new Error("Clipboard is not available");
    await navigator.clipboard.writeText(text);
    notify({ title: "Copied", description: `${label} copied to clipboard`, variant: "success" });
  } catch (error) {
    notify({ title: "Copy failed", description: error?.message || `Could not copy ${label}`, variant: "error" });
  }
}

function CopyValueButton({ value, label }) {
  const disabled = !String(value || "").trim();
  return <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-full text-muted-foreground hover:bg-background/80 hover:text-foreground" disabled={disabled} title={disabled ? `${label} unavailable` : `Copy ${label}`} onClick={() => copyLiveCallValue(value, label)}><IconCopy className="h-3.5 w-3.5" /></Button>;
}

function LiveCallIdBlock({ label, value }) {
  return <div className="rounded-xl bg-muted/35 p-3"><div className="flex items-center justify-between gap-2 text-muted-foreground"><span>{label}</span><CopyValueButton value={value} label={label} /></div><div className="mt-1 break-all font-mono leading-relaxed" title={value || ""}>{value || "—"}</div></div>;
}

function LiveCallCard({ call, now, onOpenDetails, onOpenSupervision }) {
  const elapsed = call.status === "hangup" || call.status === "failed" ? call.duration_seconds : Math.max(call.duration_seconds || 0, Math.floor((now - Date.parse(call.started_at || new Date())) / 1000));
  return <div className="group overflow-hidden rounded-2xl border bg-background/90 p-4 shadow-sm transition hover:border-foreground/25 hover:shadow-md"><div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/15 to-sky-500/15 text-emerald-600 dark:text-emerald-300"><IconPhoneCall className="h-5 w-5" /></span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate font-semibold">{call.campaign_name}</span><Badge variant="outline" className={liveCallBadgeClass(call)}>{liveCallBadgeLabel(call)}</Badge><Badge variant="outline" className="font-mono text-xs">{formatDuration(elapsed)}</Badge></div><div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="font-mono">{call.from_number}</span><span>→</span><span className="font-mono text-foreground">{call.to_number}</span>{call.call_session_id ? <span className="flex min-w-0 items-center gap-1">· session <span className="break-all font-mono text-foreground">{call.call_session_id}</span><CopyValueButton value={call.call_session_id} label="Session ID" /></span> : null}</div></div></div></div><div className="flex items-center gap-2"><Button type="button" variant="outline" size="icon" className="h-9 w-9 rounded-full bg-background/80" title="Session details" onClick={onOpenDetails}><IconInfoCircle className="h-4 w-4" /></Button><Button type="button" variant="outline" size="icon" className="h-9 w-9 rounded-full bg-background/80 text-violet-600 hover:bg-violet-500/10 dark:text-violet-300" title="Supervisory monitor" disabled={!call.can_supervise} onClick={onOpenSupervision}><IconHeadphones className="h-4 w-4" /></Button></div></div><div className="mt-3 grid gap-2 text-xs md:grid-cols-3"><LiveCallIdBlock label="Call control" value={call.call_control_id} /><LiveCallIdBlock label="Contact record" value={call.contact_record_id} /><div className="rounded-xl bg-muted/35 p-3"><div className="text-muted-foreground">Updated</div><div className="mt-1">{call.updated_at ? new Date(call.updated_at).toLocaleTimeString() : "—"}</div></div></div></div>;
}

function LiveCallsSettings({ payload, campaignFilter, setCampaignFilter, statusFilter, setStatusFilter, showDisconnectedCalls, setShowDisconnectedCalls }) {
  const totals = payload?.totals || { total: 0, active: 0, byStatus: {} };
  const campaigns = payload?.filters?.campaigns || [];
  const statuses = payload?.filters?.statuses || Object.keys(totals.byStatus || {});
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><div className="grid grid-cols-2 gap-2"><MiniStat label="Active now" value={Number(totals.active || 0).toLocaleString()} icon={IconActivity} tone="emerald" /><MiniStat label="Visible calls" value={Number(totals.total || 0).toLocaleString()} icon={IconPhoneCall} tone="violet" />{Object.entries(totals.byStatus || {}).map(([status, count]) => <MiniStat key={status} label={title(status)} value={Number(count || 0).toLocaleString()} icon={status === "hangup" ? IconPhoneOff : IconPhoneCall} tone={status === "connected" ? "emerald" : status === "ringing" ? "blue" : status === "hangup" ? "amber" : "rose"} />)}</div><SettingCard icon={IconFilter} title="Live call filters" subtitle="Filter monitoring list by campaign and current status"><div className="space-y-3"><ConfigSelect label="Campaign" value={campaignFilter || "all"} options={[{ value: "all", label: "All campaigns" }, ...campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))]} onChange={setCampaignFilter} /><ConfigSelect label="Status" value={statusFilter || "all"} options={[{ value: "all", label: "All statuses" }, ...statuses.map((status) => ({ value: status, label: title(status) }))]} onChange={setStatusFilter} /><div className="rounded-xl border bg-muted/20 p-3"><div className="flex items-start justify-between gap-3"><div><Label htmlFor="show-disconnected-live-calls" className="text-sm font-medium">Show disconnected calls</Label><p className="mt-1 text-xs text-muted-foreground">Keep hangup and failed calls visible for 60 seconds after disconnect.</p></div><Switch id="show-disconnected-live-calls" checked={showDisconnectedCalls} onCheckedChange={setShowDisconnectedCalls} /></div></div></div></SettingCard></div>;
}

function DashboardView({ campaigns, contactLists, executionDebugByCampaign, selectedCampaignId, setSelectedCampaignId, runCampaignAction, saving, showOnlyActiveCampaigns, setShowOnlyActiveCampaigns }) {
  const [expandedCampaignId, setExpandedCampaignId] = useState(null);
  const visibleCampaigns = campaigns.filter(isDashboardCampaign);
  const activeCampaigns = visibleCampaigns.filter((campaign) => isActiveDashboardCampaign(campaign, contactLists, executionDebugByCampaign?.[campaign.id]));
  const runningCampaigns = visibleCampaigns.filter((campaign) => executionStateWithRuntimeFor(campaign, contactLists, executionDebugByCampaign?.[campaign.id]) === "running");
  const dashboardCampaignCards = showOnlyActiveCampaigns ? activeCampaigns : visibleCampaigns;
  const runningCampaignIds = new Set(runningCampaigns.map((campaign) => campaign.id));
  const totalContacts = runningCampaigns.reduce((sum, campaign) => sum + campaignContactProgress(campaign, contactLists, executionDebugByCampaign?.[campaign.id]).total, 0);
  const callableContacts = runningCampaigns.reduce((sum, campaign) => sum + campaignContactProgress(campaign, contactLists, executionDebugByCampaign?.[campaign.id]).remaining, 0);
  const liveTotals = visibleCampaigns.reduce((acc, campaign) => {
    const live = campaignLiveMetrics(campaign, executionDebugByCampaign?.[campaign.id]);
    const isRunning = runningCampaignIds.has(campaign.id);
    return {
      active: acc.active + live.active,
      ringing: acc.ringing + live.ringing,
      answered: acc.answered + (isRunning ? live.answered : 0),
      failed: acc.failed + (isRunning ? live.failed : 0),
    };
  }, { active: 0, ringing: 0, answered: 0, failed: 0 });
  const metrics = [
    { label: "Campaigns", value: visibleCampaigns.length.toLocaleString(), delta: `${runningCampaigns.length} running`, icon: IconPlayerPlay, tone: "emerald" },
    { label: "Contacts", value: totalContacts.toLocaleString(), delta: `${callableContacts.toLocaleString()} callable (running campaigns)`, icon: IconUsers, tone: "blue" },
    { label: "Active calls", value: String(liveTotals.active), delta: `${liveTotals.ringing} ringing right now`, icon: IconPhoneCall, tone: "violet" },
    { label: "Realtime traffic", value: `${liveTotals.answered}/${liveTotals.failed}`, delta: "answered / failed (running campaigns)", icon: IconActivity, tone: "amber" },
  ];
  const toggleExpand = (campaignId) => setExpandedCampaignId((prev) => (prev === campaignId ? null : campaignId));
  return <div className="space-y-5"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{metrics.map((m) => { const Icon = m.icon; return <div key={m.label} className="rounded-2xl border bg-background/80 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="flex items-center justify-between"><span className={`rounded-xl bg-gradient-to-br p-2.5 ${toneClasses[m.tone]}`}><Icon className="h-5 w-5" /></span><IconDots className="h-4 w-4 text-muted-foreground" /></div><div className="mt-4 text-2xl font-semibold tracking-tight">{m.value}</div><div className="text-sm text-muted-foreground">{m.label}</div><div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-300">{m.delta}</div></div>; })}</div><div className="rounded-2xl border bg-background/80 p-5 shadow-sm"><div className="flex flex-wrap items-center gap-3"><div className="min-w-0"><h3 className="font-semibold">Campaign command center</h3><p className="text-sm text-muted-foreground">Expandable campaign cards. Only one expanded at a time.</p></div><div className="ml-auto flex items-center gap-3 rounded-full border bg-background/80 px-3 py-2 shadow-sm"><Label htmlFor="show-only-active-dashboard-campaigns" className="cursor-pointer text-xs font-medium text-muted-foreground">Show only active campaign</Label><Switch id="show-only-active-dashboard-campaigns" checked={showOnlyActiveCampaigns} onCheckedChange={setShowOnlyActiveCampaigns} /></div></div><div className="mt-4 space-y-3">{dashboardCampaignCards.length ? dashboardCampaignCards.map((c) => <DashboardCampaignCard key={c.id} campaign={c} contactLists={contactLists} executionDebug={executionDebugByCampaign?.[c.id]} selected={selectedCampaignId === c.id} expanded={expandedCampaignId === c.id} onToggleExpand={() => toggleExpand(c.id)} onSelect={() => setSelectedCampaignId(c.id)} onAction={runCampaignAction} saving={saving} />) : <Empty title={showOnlyActiveCampaigns ? "No active campaigns" : "No published campaigns"} description={showOnlyActiveCampaigns ? "Turn off Show only active campaign to also see exhausted campaigns." : "Draft and design campaigns stay in Campaigns. Set a campaign to Ready/Running/Paused/Completed to monitor it here."} />}</div></div></div>;
}

function DashboardCampaignCard({ campaign, contactLists, executionDebug, selected, expanded, onToggleExpand, onSelect, onAction, saving }) {
  const progress = campaignContactProgress(campaign, contactLists, executionDebug);
  const live = campaignLiveMetrics(campaign, executionDebug);
  const controls = campaignControlState(campaign, saving, { progress, live });
  const state = controls.state;
  const isPaused = state === "paused";
  const isRunning = state === "running";
  const pauseAction = controls.pauseAction;
  const canStart = controls.canStart;
  const canStop = controls.canStop;
  const canPause = controls.canPause;
  const canRecycle = controls.canRecycle;
  const maxLines = Number(campaign?.concurrency_config?.maxLines ?? campaign?.concurrency_config?.maxConcurrent ?? 0) || 0;
  const summary = executionDebug?.summary || {};
  const statIcons = { activity: IconActivity, database: IconDatabase, check: IconCheck, clock: IconClockHour4, shield: IconShieldCheck, phone: IconPhoneCall, x: IconX };
  const { contactStats, callProcessingStats } = buildDashboardCampaignExpandedStats({ progress, live, summary, maxLines });
  return <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(); }} className={`w-full rounded-xl border bg-card p-4 text-left transition ${selected ? "border-foreground/40 bg-muted/60 shadow-sm" : neutralCardHoverClass}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{campaign.name}</span><Badge variant="outline" className={statusClass(state)}>{title(state)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{title(campaign.mode)} · {title(campaign.channel)} · {campaign.contact_list_name || "No list attached"}</p></div>{controls.controlsDisabled ? <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}><Button type="button" variant="ghost" size="icon" className={`${controlButtonBaseClass} border-muted-foreground/30 text-muted-foreground hover:bg-muted/60`} title={expanded ? "Collapse" : "Expand"} onClick={onToggleExpand}><IconChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} /></Button></div> : <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}><Button type="button" variant="ghost" size="icon" className={controlButtonClasses.start} disabled={!canStart} title={isRunning ? "Campaign is already running" : "Start campaign"} onClick={() => onAction(campaign, "start")}><IconPlayerPlay className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" className={controlButtonClasses.stop} disabled={!canStop} title={isRunning ? "Stop campaign" : "Campaign is not running"} onClick={() => onAction(campaign, "stop")}><IconPlayerStop className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" className={controlButtonClasses[pauseAction]} disabled={!canPause} title={isPaused ? "Resume campaign" : isRunning ? "Pause campaign" : "Campaign is not running"} onClick={() => onAction(campaign, pauseAction)}>{isPaused ? <IconPlayerPlay className="h-4 w-4" /> : <IconPlayerPause className="h-4 w-4" />}</Button><Button type="button" variant="ghost" size="icon" className={controlButtonClasses.recycle} disabled={!canRecycle} title={canRecycle ? "Recycle contact processing" : "Recycle is available only for stopped campaigns"} onClick={() => onAction(campaign, "recycle")}><IconRotateClockwise className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" className={`${controlButtonBaseClass} border-muted-foreground/30 text-muted-foreground hover:bg-muted/60`} title={expanded ? "Collapse" : "Expand"} onClick={onToggleExpand}><IconChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} /></Button></div>}</div><div className="mt-3"><div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>{progress.completed.toLocaleString()} of {progress.total.toLocaleString()} records</span><span>{progress.progress}%</span></div><Progress className="h-2" value={progress.progress} /></div>{expanded ? <><div className="mt-4 space-y-2"><div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">CONTACTS STATISTICS</div><div className="grid gap-2 text-xs sm:grid-cols-5">{contactStats.map((stat) => <MiniStat key={stat.label} label={stat.label} value={stat.value} icon={statIcons[stat.icon]} tone={stat.tone} />)}</div></div><div className="mt-4 space-y-2"><div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">CALLS PROCESSING</div><div className="grid gap-2 text-xs sm:grid-cols-5">{callProcessingStats.map((stat) => <MiniStat key={stat.label} label={stat.label} value={stat.value} icon={statIcons[stat.icon]} tone={stat.tone} />)}</div></div></> : null}</div>;
}

function campaignListName(campaign, contactLists = []) {
  if (campaign?.contact_list_name) return campaign.contact_list_name;
  const list = contactLists.find((item) => item.id === campaign?.contact_list_id);
  return list?.name || "—";
}

function CampaignsView({ campaigns, contactLists = [], executionDebugByCampaign = {}, selectedCampaign, setSelectedCampaignId, archive, saving }) {
  return <CrudTable
    title="Campaign inventory"
    description="Rows select configuration in the right Settings card; execution controls stay on Dashboard."
    emptyTitle="No campaigns yet"
    emptyDescription="Use New campaign in the workspace header to create the first persisted campaign."
    columns={["Name", "Mode", "State", "Contact List", "Active", "Actions"]}
    rows={campaigns.map((c) => {
      const displayState = campaignInventoryDisplayState(c, contactLists, executionDebugByCampaign?.[c.id]);
      return {
        id: c.id,
        selected: selectedCampaign?.id === c.id,
        onSelect: () => setSelectedCampaignId(c.id),
        cells: [
          <span key="name" className="font-medium">{c.name}</span>,
          <Badge key="mode" variant="outline" className={campaignModeClass(c.mode)}>{title(c.mode)}</Badge>,
          <Badge key="state" variant="outline" className={statusClass(displayState)}>{title(displayState)}</Badge>,
          campaignListName(c, contactLists),
          <Badge key="active" variant="outline" className={activationBadgeClass(isActiveCampaignConfig(c))}>{isActiveCampaignConfig(c) ? "Active" : "Not active"}</Badge>,
        ],
        actions: <DeleteButton disabled={saving} onClick={() => archive(c)} label="Archive campaign" />,
      };
    })}
  />;
}

function ContactListsView({ contactLists, selectedList, setSelectedListId, archive, saving }) {
  return <CrudTable
    title="Contact list inventory"
    description="Import audiences and tune field schema from the right Settings card."
    emptyTitle="No contact lists yet"
    emptyDescription="Use New contact list in the workspace header, then upload or paste CSV data."
    columns={["Name", "Active", "Records", "Valid phones", "Fields", "Actions"]}
    rows={contactLists.map((l) => ({
      id: l.id,
      selected: selectedList?.id === l.id,
      onSelect: () => setSelectedListId(l.id),
      cells: [<span key="name" className="font-medium">{l.name}</span>, <Badge key="status" variant="outline" className={activationBadgeClass(l.status === "validated")}>{l.status === "validated" ? "Active" : "Not active"}</Badge>, Number(l.record_count || 0).toLocaleString(), Number(l.valid_phone_count || 0).toLocaleString(), (l.custom_field_schema || []).length],
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
    columns={["Name", "Active", "Source", "Match", "Records", "Actions"]}
    rows={dncLists.map((l) => ({
      id: l.id,
      selected: selectedDncList?.id === l.id,
      onSelect: () => setSelectedDncId(l.id),
      cells: [<span key="name" className="font-medium">{l.name}</span>, <Badge key="status" variant="outline" className={activationBadgeClass(isActiveConfigItem(l))}>{isActiveConfigItem(l) ? "Active" : "Not active"}</Badge>, title(l.source_type || "csv"), title(l.match_strategy || "phone"), Number(l.record_count || 0).toLocaleString()],
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
    columns={["Name", "Active", "Contact list", "Rules", "Actions"]}
    rows={filters.map((f) => ({
      id: f.id,
      selected: selectedFilter?.id === f.id,
      onSelect: () => setSelectedFilterId(f.id),
      cells: [<span key="name" className="font-medium">{f.name}</span>, <Badge key="status" variant="outline" className={activationBadgeClass(isActiveConfigItem(f))}>{isActiveConfigItem(f) ? "Active" : "Not active"}</Badge>, f.contact_list_name || "Any list", `${(f.conditions || []).length} rule${(f.conditions || []).length === 1 ? "" : "s"}`],
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
    columns={["Name", "Active", "Time zone", "Windows", "Actions"]}
    rows={timeSets.map((t) => ({
      id: t.id,
      selected: selectedTimeSet?.id === t.id,
      onSelect: () => setSelectedTimeSetId(t.id),
      cells: [<span key="name" className="font-medium">{t.name}</span>, <Badge key="status" variant="outline" className={activationBadgeClass(isActiveConfigItem(t))}>{isActiveConfigItem(t) ? "Active" : "Not active"}</Badge>, t.timezone || "Europe/Warsaw", `${(t.windows || []).filter((w) => w.enabled !== false).length} active`],
      actions: <DeleteButton disabled={saving} onClick={() => archive(t)} label="Archive time set" />,
    }))}
  />;
}

function dispositionClassificationLabel(value) {
  return ({ none: "Complete only", right_party_contact: "Right Party Contact", number_uncallable: "Number Uncallable", contact_uncallable: "Contact Uncallable", retry: "Retry / Callback" })[value] || title(value);
}

function defaultDispositionCode(wrapupCodes = []) {
  return { wrapup_code_id: wrapupCodes[0]?.id || "default", campaign_id: null, classification: "none", business_category: "none", retry_eligible: false, requires_callback: false, status: "active", metadata: {} };
}

function DispositionCodesView({ dispositionCodes, selectedDispositionCode, setSelectedDispositionCodeId, archive, saving }) {
  const counts = dispositionCodes.reduce((acc, item) => ({ ...acc, [item.classification || "none"]: (acc[item.classification || "none"] || 0) + 1 }), {});
  const dispositionSummaryClassifications = [
    { key: "none", icon: IconListDetails, tone: "blue" },
    { key: "right_party_contact", icon: IconCheck, tone: "emerald" },
    { key: "retry", icon: IconRefresh, tone: "amber" },
    { key: "number_uncallable", icon: IconPhoneOff, tone: "rose" },
    { key: "contact_uncallable", icon: IconShieldCheck, tone: "violet" },
  ];
  return <div className="space-y-5">
    <div className="overflow-hidden rounded-2xl border bg-background/85 p-5 shadow-sm">
      <div className="space-y-4">
        <h3 className="text-xl font-semibold tracking-tight">Disposition codes</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-5 text-xs">
          {dispositionSummaryClassifications.map(({ key, icon: dispositionSummaryIcon, tone }) => {
            const Icon = dispositionSummaryIcon;
            return <div key={key} className="relative overflow-hidden rounded-2xl border bg-white/90 p-3 pr-12 shadow-sm dark:bg-white/10"><div className="text-lg font-semibold">{counts[key] || 0}</div><div className="mt-1 text-muted-foreground">{dispositionClassificationLabel(key)}</div>{Icon ? <span className={`absolute right-3 top-3 rounded-xl bg-gradient-to-br p-2 ${toneClasses[tone] || toneClasses.blue}`}><Icon className="h-4 w-4" /></span> : null}</div>;
          })}
        </div>
      </div>
    </div>
    <CrudTable
      title="Campaign disposition mapping"
      description="Supervisor-owned mappings from wrap-up codes to campaign disposition outcomes. Campaign-specific mappings override global mappings."
      emptyTitle="No disposition mappings yet"
      emptyDescription="Use New disposition mapping to map wrap-up codes to outbound outcomes."
      columns={["Wrap-up code", "Scope", "Classification", "Business Category", "Active", "Actions"]}
      rows={dispositionCodes.map((d) => ({
        id: d.id,
        selected: selectedDispositionCode?.id === d.id,
        onSelect: () => setSelectedDispositionCodeId(d.id),
        cells: [
          <span key="name" className="font-medium">{d.wrapup_code_name || d.wrapup_code_id}</span>,
          d.campaign_name || "Global",
          <Badge key="classification" variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">{dispositionClassificationLabel(d.classification)}</Badge>,
          d.business_category && d.business_category !== "none" ? title(d.business_category) : "—",
          <Badge key="status" variant="outline" className={activationBadgeClass(isActiveConfigItem(d))}>{isActiveConfigItem(d) ? "Active" : "Not active"}</Badge>,
        ],
        actions: <DeleteButton disabled={saving} onClick={() => archive(d)} label="Archive disposition mapping" />,
      }))}
    />
  </div>;
}


function AttemptControlsView({ attemptControls, selectedAttemptControl, setSelectedAttemptControlId, archive, saving }) {
  return <CrudTable
    title="Attempt control rules"
    description="Genesys-style attempt caps and recall cadence. Campaigns can attach one rule set from Campaign Options."
    emptyTitle="No attempt controls yet"
    emptyDescription="Use New attempt control to create caps, reset periods, and recall behavior."
    columns={["Name", "Active", "Reset", "Caps", "Recall", "Actions"]}
    rows={attemptControls.map((a) => ({
      id: a.id,
      selected: selectedAttemptControl?.id === a.id,
      onSelect: () => setSelectedAttemptControlId(a.id),
      cells: [<span key="name" className="font-medium">{a.name}</span>, <Badge key="status" variant="outline" className={activationBadgeClass(isActiveConfigItem(a))}>{isActiveConfigItem(a) ? "Active" : "Not active"}</Badge>, `${title(a.reset_period || "daily")} · ${a.timezone || "Europe/Warsaw"}`, `${Number(a.max_attempts_per_contact || 0)} contact / ${Number(a.max_attempts_per_number || 0)} number`, `${(a.recall_rules || []).length + (a.phone_type_rules || []).reduce((sum, row) => sum + (row.rules || []).length, 0)} rules`],
      actions: <DeleteButton disabled={saving} onClick={() => archive(a)} label="Archive attempt control" />,
    }))}
  />;
}

function ReportsView({ campaigns, contactLists, dncLists, executionDebugByCampaign, selectedCampaignId, setSelectedCampaignId }) {
  const [detailsInteraction, setDetailsInteraction] = useState(null);
  const [expandedRecordId, setExpandedRecordId] = useState(null);
  const [attemptsPage, setAttemptsPage] = useState(1);
  const [attemptsPageSize, setAttemptsPageSize] = useState(10);
  const selectedCampaign = campaigns.find((c) => c.id === selectedCampaignId) || campaigns[0] || null;
  const selectedContactList = selectedCampaign ? contactLists.find((list) => list.id === selectedCampaign.contact_list_id) : null;
  const campaignDebug = selectedCampaign ? executionDebugByCampaign?.[selectedCampaign.id] : null;
  const attempts = Array.isArray(campaignDebug?.recent_attempts) ? campaignDebug.recent_attempts : [];
  const records = Array.isArray(campaignDebug?.contact_records) ? campaignDebug.contact_records : [];
  const recordGroups = useMemo(() => groupAttemptsByContactRecord(records, attempts, selectedContactList), [records, attempts, selectedContactList]);
  useEffect(() => { setAttemptsPage(1); setExpandedRecordId(null); }, [selectedCampaign?.id, attemptsPageSize]);
  const paginatedRecordGroups = useMemo(() => paginateItems(recordGroups, attemptsPage, attemptsPageSize), [recordGroups, attemptsPage, attemptsPageSize]);
  const progress = selectedCampaign ? campaignContactProgress(selectedCampaign, contactLists, campaignDebug) : { total: 0, completed: 0, remaining: 0 };
  const summary = campaignDebug?.summary || {};
  const totalAttempts = attempts.length || Number(summary.attempts_last_15m || 0) || 0;
  const answered = Number(summary.answered_total || attempts.filter((a) => a.status === "answered" || a.status === "completed").length || 0);
  const failed = Number(summary.failed_total || attempts.filter((a) => a.status === "failed").length || 0);
  const suppressed = Number(summary.suppressed_total || attempts.filter((a) => a.status === "suppressed" || a.status === "skipped").length || 0);
  const successRate = totalAttempts ? Math.round((answered / Math.max(totalAttempts, answered + failed + suppressed)) * 100) : 0;
  const statusBuckets = attempts.reduce((acc, attempt) => ({ ...acc, [attempt.status || "unknown"]: (acc[attempt.status || "unknown"] || 0) + 1 }), {});
  const reasonBuckets = attempts.reduce((acc, attempt) => {
    const reason = attemptReasonCode(attempt);
    return { ...acc, [reason]: (acc[reason] || 0) + 1 };
  }, {});
  const openAttemptDetails = (attempt) => setDetailsInteraction({
    id: attempt.id,
    call_control_id: attempt.call_control_id || null,
    call_session_id: attempt.call_session_id || null,
    from_number: attempt.from_number || "",
    to_number: attempt.to_number || "",
    direction: "outbound",
    state: attempt.status,
    created_at: attempt.created_at,
    assigned_at: attempt.created_at,
    answered_at: attempt.status === "answered" || attempt.status === "completed" ? attempt.updated_at : null,
    completed_at: attempt.updated_at,
  });
  return <div className="space-y-5">
    {selectedCampaign ? <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><MiniStat label="Records" value={`${progress.completed}/${progress.total}`} icon={IconUsers} tone="blue" /><MiniStat label="Calls" value={String(totalAttempts)} icon={IconPhoneCall} tone="violet" /><MiniStat label="Success rate" value={`${successRate}%`} icon={IconChartBar} tone="emerald" /><MiniStat label="Remaining" value={String(progress.remaining)} icon={IconClockHour4} tone="amber" /></div>
      <div className="grid gap-4 xl:grid-cols-2"><SettingCard icon={IconChartBar} title="Attempt outcomes" subtitle="Ledger status distribution"><BarList data={statusBuckets} /></SettingCard><SettingCard icon={IconReportAnalytics} title="Failure / retry reasons" subtitle="failure_reason, reason_code, suppression_reason"><BarList data={reasonBuckets} /></SettingCard></div>
      <SettingCard icon={IconListDetails} title="Call attempts" subtitle="Contact-list records grouped as accordions; expand each record to inspect attempts newest first."><div className="space-y-3"><PaginatedListControls total={recordGroups.length} page={attemptsPage} pageSize={attemptsPageSize} onPageChange={setAttemptsPage} onPageSizeChange={setAttemptsPageSize} label="contact records" />{recordGroups.length ? <div className="space-y-2">{paginatedRecordGroups.items.map((group) => <ContactRecordAttemptAccordion key={group.id} group={group} expanded={expandedRecordId === group.id} onToggle={() => setExpandedRecordId((prev) => prev === group.id ? null : group.id)} onOpenAttemptDetails={openAttemptDetails} />)}</div> : <Empty title="No contact records yet" description="Contact-list records and their outbound attempts will appear here." />}</div></SettingCard>
    </> : <Empty title="No campaigns" description="Create a campaign to populate outbound history." />}
    <InteractionDetailsSheet open={!!detailsInteraction} onOpenChange={(open) => !open && setDetailsInteraction(null)} interaction={detailsInteraction} />
  </div>;
}

function reasonCodeClass(reason) {
  const value = String(reason || "").toLowerCase();
  if (["completed", "answered", "success", "human"].includes(value)) return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (["user_busy", "busy", "failed", "rejected", "declined", "error"].includes(value)) return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  if (["timeout", "no_answer", "no-answer", "answering_machine", "machine", "machine_detected"].includes(value)) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (["dialing", "claimed", "in_progress"].includes(value)) return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (["suppressed", "skipped", "dnc"].includes(value)) return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
  return statusClass(value);
}

function ContactRecordAttemptAccordion({ group, expanded, onToggle, onOpenAttemptDetails }) {
  const label = group.label || contactRecordLabel(group.record);
  const headerLabel = contactRecordHeaderLabel(label);
  const statusEntries = Object.entries(group.status_counts || {}).filter(([, value]) => Number(value) > 0).sort((a, b) => b[1] - a[1]);
  return <div className="overflow-hidden rounded-xl border bg-muted/20 text-sm">
    <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition hover:bg-muted/35">
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{headerLabel}</div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5"><Badge variant="outline" className="bg-card"><span className="mr-1 text-muted-foreground">Attempts :</span><span className="rounded-md bg-muted px-1.5 py-0.5 font-semibold text-foreground">{Number(group.attempt_count || 0)}</span></Badge>{statusEntries.length ? statusEntries.map(([status, count]) => <Badge key={status} variant="outline" className={`${attemptStatusClass(status)} gap-1.5`}><span>{title(status)} :</span><span className="rounded-md bg-background/70 px-1.5 py-0.5 font-semibold">{Number(count).toLocaleString()}</span></Badge>) : <span className="text-xs text-muted-foreground">No dialing attempts yet</span>}</div>
      </div>
      <IconChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
    </button>
    {expanded ? <div className="border-t bg-background/45 p-3"><div className="space-y-2">{group.attempts.length ? group.attempts.map((attempt) => {
      const statusReasonLabel = attemptStatusReasonLabel(attempt);
      return <div key={attempt.id} className="rounded-lg border bg-card/70 px-3 py-2"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{attempt.to_number || label.to}</span><span className="text-xs text-muted-foreground">from {attempt.from_number || "—"}</span></div><div className="mt-1 text-xs text-muted-foreground">{attempt.created_at ? new Date(attempt.created_at).toLocaleString() : "no timestamp"}{attempt.updated_at ? ` · updated ${new Date(attempt.updated_at).toLocaleString()}` : ""}</div></div><div className="ml-auto flex shrink-0 items-center gap-2"><Badge variant="outline" className={attemptStatusClass(attempt.status)}>{statusReasonLabel}</Badge><Button size="icon" variant="ghost" className="h-8 w-8" disabled={!attempt.call_session_id && !attempt.call_control_id} onClick={() => onOpenAttemptDetails(attempt)} title="Call Session Details"><IconInfoCircle className="h-4 w-4" /></Button></div></div></div>;
    }) : <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No attempts for this contact record yet.</div>}</div></div> : null}
  </div>;
}

function BarList({ data = {} }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, value]) => Number(value) || 0));
  return <div className="space-y-2">{entries.length ? entries.map(([label, value]) => <div key={label} className="space-y-1"><div className="flex items-center justify-between text-xs"><span className="font-medium">{title(label)}</span><span className="text-muted-foreground">{value}</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-sky-500" style={{ width: `${Math.max(4, Math.round((Number(value) / max) * 100))}%` }} /></div></div>) : <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No data yet.</div>}</div>;
}

function EventViewerView({ campaigns, executionDebugByCampaign, campaignId, typeFilter }) {
  const [eventsPage, setEventsPage] = useState(1);
  const [eventsPageSize, setEventsPageSize] = useState(10);
  const selectedCampaign = campaigns.find((campaign) => campaign.id === campaignId) || null;
  const allEvents = useMemo(() => outboundEventsFromCampaigns(campaigns, executionDebugByCampaign), [campaigns, executionDebugByCampaign]);
  const events = useMemo(() => allEvents.filter((event) => event.campaign_id === campaignId && (typeFilter === "all" || event.type === typeFilter)), [allEvents, campaignId, typeFilter]);
  useEffect(() => { setEventsPage(1); }, [campaignId, typeFilter, eventsPageSize]);
  const paginatedEvents = useMemo(() => paginateItems(events, eventsPage, eventsPageSize), [events, eventsPage, eventsPageSize]);
  return <div className="space-y-4"><div className="rounded-2xl border bg-background/85 p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">Event viewer</h3><p className="text-sm text-muted-foreground">Campaign status changes for the selected campaign only.</p>{selectedCampaign ? <p className="mt-1 text-xs text-muted-foreground">Campaign: <span className="font-medium text-foreground">{selectedCampaign.name}</span></p> : null}</div><Badge variant="outline" className="bg-card">{events.length} events</Badge></div></div><SettingCard icon={IconListDetails} title="Campaign status timeline" subtitle="Dialing-attempt events are intentionally hidden"><div className="space-y-3"><PaginatedListControls total={events.length} page={eventsPage} pageSize={eventsPageSize} onPageChange={setEventsPage} onPageSizeChange={setEventsPageSize} label="events" /><EventList events={paginatedEvents.items} empty={campaignId ? "No matching campaign status events for the selected campaign/type." : "Select a campaign to view its status events."} /></div></SettingCard></div>;
}

function SettingsSummaryView({ settings }) {
  const window = settings?.callable_window || defaultOutboundSettings().callable_window;
  const callableDays = normalizedCallableDays(settings);
  return <div className="space-y-4"><div className="rounded-2xl border bg-background/85 p-5 shadow-sm"><h3 className="text-lg font-semibold">Outbound workspace settings</h3><p className="text-sm text-muted-foreground">Global dialer defaults. Edit and persist these from Context Settings on the right.</p></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5"><MiniStat label="Max calls / agent" value={settings?.max_calls_per_agent ?? 1} icon={IconPhoneCall} tone="blue" /><MiniStat label="Max lines" value={`${settings?.max_lines ?? 10} lines`} icon={IconPhoneCall} tone="emerald" /><MiniStat label="Line utilization" value={`${settings?.max_line_utilization_percent ?? 90}%`} icon={IconChartBar} tone="violet" /><MiniStat label="Max CPS" value={settings?.max_cps ?? settings?.maxCps ?? 50} icon={IconShieldCheck} tone="amber" /><MiniStat label="Callable days" value={callableDays.length} icon={IconCalendar} tone="emerald" /></div><SettingCard icon={IconPhoneCall} title="Allowed Numbers" subtitle="Numbers enabled for campaigns to be used as CLI"><div className="flex flex-wrap gap-2">{(Array.isArray(settings?.allowed_numbers) ? settings.allowed_numbers : []).length ? (settings.allowed_numbers || []).map((number) => <Badge key={number} className="bg-transparent text-[#00E58F] border-[#00E58F]">{number}</Badge>) : <p className="text-xs text-muted-foreground">No allowed numbers selected.</p>}</div></SettingCard><SettingCard icon={IconClockHour4} title="Time Zone Settings" subtitle="Defaults used for newly created Time Sets"><div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">{window.earliest || "09:00"}–{window.latest || "20:00"} · {window.timezone || "Europe/Warsaw"} · {callableDays.map(title).join(", ")}</div></SettingCard></div>;
}

function CrudTable({ title: tableTitle, description, columns, rows, emptyTitle, emptyDescription }) {
  return <div className="rounded-2xl border bg-background/85 p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">{tableTitle}</h3><p className="text-sm text-muted-foreground">{description}</p></div><Badge variant="outline" className="bg-card">{rows.length} total</Badge></div>{rows.length ? <div className="mt-5 overflow-hidden rounded-xl border"><div className="grid bg-muted/45 px-3 py-2 text-xs font-semibold text-muted-foreground" style={{ gridTemplateColumns: `repeat(${columns.length - 1}, minmax(0, 1fr)) 76px` }}>{columns.map((c) => <span key={c} className={c === "Actions" ? "text-right" : ""}>{c}</span>)}</div>{rows.map((row) => <div key={row.id} role="button" tabIndex={0} onClick={row.onSelect} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") row.onSelect(); }} className={`grid items-center gap-3 border-t px-3 py-3 text-sm transition ${row.selected ? "bg-muted/70" : "bg-background/70 hover:bg-muted/40"}`} style={{ gridTemplateColumns: `repeat(${columns.length - 1}, minmax(0, 1fr)) 76px` }}>{row.cells.map((cell, idx) => <div key={idx} className="min-w-0 truncate">{cell}</div>)}<div className="flex justify-end" onClick={(e) => e.stopPropagation()}>{row.actions}</div></div>)}</div> : <div className="mt-5"><Empty title={emptyTitle} description={emptyDescription} /></div>}</div>;
}

function DeleteButton({ onClick, disabled, label }) {
  return <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600" disabled={disabled} onClick={onClick} title={label}><IconTrash className="h-4 w-4" /></Button>;
}

function SettingsPanel({ active, campaigns = [], campaign, selectedCampaignId, setSelectedCampaignId, contactList, dncList, filter, timeSet, dispositionCode, wrapupCodes = [], attemptControl, outboundSettings, inventoryNumbers, forms, contactLists, dncLists, filters, timeSets, attemptControls, handlerReferences, schema, saveCampaign, saveList, saveDncList, saveFilter, saveTimeSet, saveDispositionCode, saveAttemptControl, saveOutboundSettings, saving, onImported, registerHeaderSaveAction, reasonMetrics, reasonMetricsLoading, selectedReasonDay, onSelectReasonDay, executionDebug, eventViewerCampaignId, setEventViewerCampaignId, eventViewerType, setEventViewerType, eventViewerTypes, executionDebugByCampaign, liveCallsPayload, liveCampaignFilter, setLiveCampaignFilter, liveStatusFilter, setLiveStatusFilter, showDisconnectedLiveCalls, setShowDisconnectedLiveCalls, timeSetEditorView, setTimeSetEditorView }) {
  if (active === "dashboard") return <DashboardMonitorPanel campaign={campaign} contactLists={contactLists} reasonMetrics={reasonMetrics} reasonMetricsLoading={reasonMetricsLoading} selectedReasonDay={selectedReasonDay} onSelectReasonDay={onSelectReasonDay} executionDebug={executionDebug} />;
  if (active === "live-calls") return <LiveCallsSettings payload={liveCallsPayload} campaignFilter={liveCampaignFilter} setCampaignFilter={setLiveCampaignFilter} statusFilter={liveStatusFilter} setStatusFilter={setLiveStatusFilter} showDisconnectedCalls={showDisconnectedLiveCalls} setShowDisconnectedCalls={setShowDisconnectedLiveCalls} />;
  if (active === "campaigns") return <CampaignSettingsForm campaign={campaign} outboundSettings={outboundSettings} forms={forms} contactLists={contactLists} dncLists={dncLists} filters={filters} timeSets={timeSets} attemptControls={attemptControls} handlerReferences={handlerReferences} schema={schema} saveCampaign={saveCampaign} saving={saving} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "contact-lists") return <ContactListSettingsForm contactList={contactList} schema={schema} saveList={saveList} saving={saving} onImported={onImported} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "dnc") return <DncSettingsForm dncList={dncList} schema={schema} saveDncList={saveDncList} saving={saving} onImported={onImported} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "filters") return <FilterSettingsForm filter={filter} contactLists={contactLists} schema={schema} saveFilter={saveFilter} saving={saving} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "time-sets") return <TimeSetSettingsForm timeSet={timeSet} outboundSettings={outboundSettings} saveTimeSet={saveTimeSet} saving={saving} registerHeaderSaveAction={registerHeaderSaveAction} view={timeSetEditorView} setView={setTimeSetEditorView} />;
  if (active === "disposition-codes") return <DispositionCodesSettingsForm dispositionCode={dispositionCode} wrapupCodes={wrapupCodes} campaigns={campaigns} saveDispositionCode={saveDispositionCode} saving={saving} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "attempt-controls") return <AttemptControlSettingsForm attemptControl={attemptControl} outboundSettings={outboundSettings} schema={schema} saveAttemptControl={saveAttemptControl} saving={saving} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "settings") return <OutboundSettingsForm settings={outboundSettings} inventoryNumbers={inventoryNumbers} saveOutboundSettings={saveOutboundSettings} saving={saving} registerHeaderSaveAction={registerHeaderSaveAction} />;
  if (active === "reports") return <ReportsSettings campaigns={campaigns} selectedCampaignId={selectedCampaignId} setSelectedCampaignId={setSelectedCampaignId} />;
  if (active === "event-viewer") return <EventViewerSettings campaigns={campaigns} contactLists={contactLists} selectedCampaignId={eventViewerCampaignId} setSelectedCampaignId={setEventViewerCampaignId} selectedType={eventViewerType} setSelectedType={setEventViewerType} eventTypes={eventViewerTypes} />;
  return <div className="flex-1 min-h-0 overflow-y-auto p-4"><div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No context settings for this section.</div></div>;
}

function ReportsSettings({ campaigns, selectedCampaignId, setSelectedCampaignId }) {
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconReportAnalytics} title="History filters" subtitle="Select campaign shown in the History workspace"><ConfigSelect label="Campaign" value={selectedCampaignId || campaigns[0]?.id || ""} options={campaigns.map((c) => ({ value: c.id, label: c.name }))} onChange={setSelectedCampaignId} /></SettingCard></div>;
}

function EventViewerSettings({ campaigns, selectedCampaignId, setSelectedCampaignId, selectedType, setSelectedType, eventTypes }) {
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconListDetails} title="Event Viewer filters" subtitle="Select one campaign and event type"><ConfigSelect label="Campaign" value={selectedCampaignId || campaigns[0]?.id || ""} options={campaigns.map((c) => ({ value: c.id, label: c.name }))} onChange={setSelectedCampaignId} /><ConfigSelect label="Type" value={selectedType || "all"} options={(eventTypes || ["all"]).map((type) => ({ value: type, label: type === "all" ? "All status types" : title(type) }))} onChange={setSelectedType} /></SettingCard></div>;
}

function CampaignSettingsForm({ campaign, outboundSettings, forms, contactLists, dncLists, filters, timeSets, attemptControls, handlerReferences, schema, saveCampaign, saving, registerHeaderSaveAction }) {
  const [draft, setDraft] = useState(campaign || defaultCampaign());
  useEffect(() => setDraft(campaign || defaultCampaign()), [campaign]);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const updateJson = (key, patch) => setDraft((d) => ({ ...d, [key]: { ...(d[key] || {}), ...patch } }));
  const updateMetadata = (patch) => updateJson("metadata", patch);
  const selectedList = contactLists.find((l) => l.id === draft.contact_list_id);
  const phoneFields = contactListNumberOptions(selectedList, schema);
  const contactListOptions = contactLists.length ? contactLists.map((l) => ({ value: l.id, label: l.name })) : [{ value: "__no_validated_contact_lists__", label: "Validate a contact list first", disabled: true }];
  const mode = draft.mode || "preview";
  const referenceKind = campaignReferenceKindForMode(mode);
  const queueTargetRequired = campaignRequiresQueueTarget(mode);
  const handlerOptions = queueTargetRequired ? handlerReferences?.[referenceKind] || [] : [];
  const workflowOptions = handlerReferences?.workflow || [];
  const showPacing = ["power", "predictive"].includes(mode);
  const showAgentScript = ["preview", "progressive"].includes(mode);
  const amdAvailable = AMD_ELIGIBLE_CAMPAIGN_MODES.includes(mode);
  const maxLines = draft.concurrency_config?.maxLines ?? draft.concurrency_config?.maxConcurrent ?? 10;
  const delayMinutes = draft.retry_policy?.delayBetweenAttemptsMinutes ?? (((Number(draft.retry_policy?.minDelayHours) || 0) * 60) || 360);
  const selectedNumberFields = draft.metadata?.contact_list_numbers || [];
  const rotateNumbers = draft.metadata?.rotate_numbers === true;
  const globalMaxAttempts = normalizeGlobalMaxAttempts(outboundSettings?.global_max_attempts ?? outboundSettings?.globalMaxAttempts);
  const globalDialTimeoutSecs = normalizeDialTimeoutSecs(outboundSettings?.dial_timeout_secs ?? outboundSettings?.dialTimeoutSecs, 30);
  const campaignDialTimeoutSecs = normalizeDialTimeoutSecs(draft.metadata?.dial_timeout_secs ?? draft.metadata?.dialTimeoutSecs, globalDialTimeoutSecs);
  const campaignMaxAttempts = normalizeAttemptCount(draft.retry_policy?.maxAttempts, 4, globalMaxAttempts) || 1;
  const maxRetriesPerContact = Math.max(0, campaignMaxAttempts - 1);
  const allowedCampaignNumbers = Array.isArray(draft.metadata?.from_numbers) ? draft.metadata.from_numbers.slice(0, campaignMaxAttempts) : [];
  const allowedSettingsNumbers = Array.isArray(outboundSettings?.allowed_numbers) ? outboundSettings.allowed_numbers : [];
  const allowedCampaignNumberOptions = allowedSettingsNumbers.map((value) => ({ value, label: value }));
  const rotationSlotCount = rotateNumbers ? campaignMaxAttempts : 1;
  const rotationSlots = Array.from({ length: rotationSlotCount }, (_, idx) => allowedCampaignNumbers[idx] || "");
  const campaignModes = [...(schema.campaignModes || [])].sort((a, b) => (["agentless_ai", "agentless_flow"].includes(a) ? 1 : 0) - (["agentless_ai", "agentless_flow"].includes(b) ? 1 : 0));
  const normalizedDraft = { ...draft, mode, handler_type: referenceKind };
  const saveRequirements = campaignSaveRequirements(normalizedDraft, { maxAttempts: campaignMaxAttempts });
  const channelOptions = (schema.channels || ["voice", "sms", "whatsapp"]).map((channel) => ({ value: channel, label: channel === "voice" ? "Voice" : `${title(channel)} — not available yet`, disabled: channel !== "voice" }));
  const agentScriptValue = draft.attached_form_id ? `form:${draft.attached_form_id}` : draft.metadata?.attached_workflow_id ? `workflow:${draft.metadata.attached_workflow_id}` : "none";
  const campaignPriority = normalizeCampaignPriority(draft);
  const handleModeChange = (nextMode) => {
    const nextReferenceKind = campaignReferenceKindForMode(nextMode);
    const nextRequiresQueueTarget = campaignRequiresQueueTarget(nextMode);
    update((draft.handler_type || referenceKind) === nextReferenceKind && nextRequiresQueueTarget ? { mode: nextMode, handler_type: nextReferenceKind } : { mode: nextMode, handler_type: nextReferenceKind, handler_ref: "" });
  };
  const handleAgentScriptChange = (value) => {
    if (value === "none") return update({ attached_form_id: null, metadata: { ...(draft.metadata || {}), attached_workflow_id: null, workflow_id: null } });
    if (value.startsWith("form:")) return update({ attached_form_id: value.slice(5), metadata: { ...(draft.metadata || {}), attached_workflow_id: null, workflow_id: null } });
    if (value.startsWith("workflow:")) return update({ attached_form_id: null, metadata: { ...(draft.metadata || {}), attached_workflow_id: value.slice(9), workflow_id: value.slice(9) } });
  };
  const save = useCallback(() => {
    const campaignToSave = { ...draft, mode, handler_type: referenceKind };
    const requirements = campaignSaveRequirements(campaignToSave, { maxAttempts: campaignMaxAttempts });
    if (!requirements.canSave) {
      notify({ title: "Campaign is incomplete", description: "Complete the required fields marked with a red asterisk before saving.", variant: "error" });
      return;
    }
    saveCampaign({ ...campaignToSave, retry_policy: { ...(draft.retry_policy || {}), maxAttempts: campaignMaxAttempts }, amd_config: { ...(draft.amd_config || {}), enabled: amdAvailable && draft.amd_config?.enabled === true }, metadata: { ...(draft.metadata || {}), dial_timeout_secs: campaignDialTimeoutSecs } });
  }, [amdAvailable, campaignDialTimeoutSecs, campaignMaxAttempts, draft, mode, referenceKind, saveCampaign]);
  useEffect(() => { registerHeaderSaveAction({ section: "campaigns", label: "Save campaign", disabled: saving || !saveRequirements.canSave, busy: saving, onSave: save }); return () => registerHeaderSaveAction(null); }, [saveRequirements.canSave, saving, save, registerHeaderSaveAction]);
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
    <SettingCard icon={IconPhoneCall} title="Campaign Details" subtitle="Name, description, and activation visibility">
      <InputBlock label="Campaign Name" required value={draft.name} onChange={(v) => update({ name: v })} />
      <div className="mt-3"><Label>Description</Label><Textarea className="mt-2" rows={3} value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} /></div>
      <div className="mt-3"><ToggleRow label="Active" checked={isActiveCampaignConfig(draft)} onCheckedChange={(checked) => update(activeToggleStatusPatch(checked, "ready", "draft"))} /><p className="mt-2 text-xs text-muted-foreground">Active campaigns are visible in Command Center and can be started. Not active campaigns stay in Draft configuration.</p></div>
      <CampaignPriorityStarRating label="Priority" value={campaignPriority} onChange={(priority) => updateMetadata({ agent_priority: priority })} />
    </SettingCard>
    <SettingCard icon={IconAdjustmentsHorizontal} title="Dialing Strategy" subtitle="Voice execution settings and Agent desktop script selection">
      <div className="grid grid-cols-2 gap-3">
        <ConfigSelect label="Channel" value={draft.channel || "voice"} options={channelOptions} onChange={(v) => update({ channel: v })} />
        <ConfigSelect label="Mode" value={mode} options={campaignModes} onChange={handleModeChange} />
        <CampaignReferenceSelect label="Target" required={queueTargetRequired} disabled={!queueTargetRequired} kind={referenceKind} value={queueTargetRequired ? draft.handler_ref || "none" : "none"} options={handlerOptions} onChange={(v) => update({ handler_type: referenceKind, handler_ref: v === "none" ? "" : v })} />
        {showAgentScript ? <AgentScriptSelect label="Agent Script" value={agentScriptValue} forms={forms} workflows={workflowOptions} onChange={handleAgentScriptChange} /> : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <InputBlock label="Max Lines" type="number" value={maxLines} onChange={(v) => updateJson("concurrency_config", { maxLines: Number(v) || 0, maxConcurrent: Number(v) || 0 })} />
        <InputBlock label="Dial Timeout (sec)" type="number" min={15} value={campaignDialTimeoutSecs} onChange={(v) => updateMetadata({ dial_timeout_secs: normalizeDialTimeoutSecs(v, globalDialTimeoutSecs) })} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <InputBlock label="Max attempts" type="number" min={1} max={globalMaxAttempts} value={campaignMaxAttempts} onChange={(v) => updateJson("retry_policy", { maxAttempts: Math.max(1, normalizeAttemptCount(v, 1, globalMaxAttempts)) })} />
        <InputBlock label="Attempts delay (min)" type="number" value={delayMinutes} onChange={(v) => updateJson("retry_policy", { delayBetweenAttemptsMinutes: Number(v) || 0, minDelayHours: Math.round((Number(v) || 0) / 60) })} />
      </div>
      {showPacing ? <div className="mt-3 grid grid-cols-2 gap-3"><InputBlock label="Pacing Ratio" type="number" value={draft.pacing_config?.ratio || 1} onChange={(v) => updateJson("pacing_config", { ratio: Number(v) || 1 })} /></div> : null}
      {amdAvailable ? <CampaignAmdSettings amdConfig={draft.amd_config || {}} onChange={(patch) => updateJson("amd_config", patch)} /> : <div className="mt-3 rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">Answering Machine Detection is available only for agentless, power, and predictive campaigns.</div>}
    </SettingCard>
    <SettingCard icon={IconForms} title="Campaign Options" subtitle="Audience, suppression, filters, and contactable windows">
      <div className="grid gap-3">
        <ConfigSelect label="Contact List" required value={draft.contact_list_id || "none"} options={[{ value: "none", label: "Not attached" }, ...contactListOptions]} onChange={(v) => update({ contact_list_id: v === "none" || v === "__no_validated_contact_lists__" ? null : v })} />
        <MultiSelect label="Contact List Numbers" required values={selectedNumberFields} options={phoneFields} emptyLabel="Attach a contact list with phone fields to choose callable numbers." onChange={(values) => updateMetadata({ contact_list_numbers: values })} />
        <ToggleRow label="Rotate numbers" checked={rotateNumbers} onCheckedChange={(checked) => { const nextChecked = checked === true; const current = Array.isArray(draft.metadata?.from_numbers) ? draft.metadata.from_numbers : []; updateMetadata({ rotate_numbers: nextChecked, from_numbers: nextChecked ? current.slice(0, campaignMaxAttempts) : current.slice(0, 1) }); }} />
        <div className="rounded-lg border bg-muted/20 p-3 text-xs space-y-2"><div className="font-medium">FROM number slots</div><p className="text-muted-foreground">Default call + {maxRetriesPerContact} retry slots (max {campaignMaxAttempts} total attempts).</p>{rotationSlots.map((slotValue, idx) => <ConfigSelect key={`from-slot-${idx}`} label={idx === 0 ? "Default" : `Retry ${idx}`} required={idx < saveRequirements.requiredFromSlots} value={slotValue || "none"} options={[{ value: "none", label: "Not set" }, ...allowedCampaignNumberOptions]} onChange={(value) => { const next = [...rotationSlots]; next[idx] = value === "none" ? "" : value; const cleaned = next.filter((item, itemIdx) => item || itemIdx === 0).filter(Boolean).slice(0, rotationSlotCount); updateMetadata({ from_numbers: cleaned }); }} />)}</div>
        <ConfigSelect label="DNC List" value={draft.metadata?.dnc_list_id || "none"} options={[{ value: "none", label: "No DNC list" }, ...dncLists.map((l) => ({ value: l.id, label: l.name }))]} onChange={(v) => updateMetadata({ dnc_list_id: v === "none" ? null : v })} />
        <ConfigSelect label="Contact List Filter" value={draft.metadata?.contact_list_filter_id || "none"} options={[{ value: "none", label: "No filter" }, ...filters.map((f) => ({ value: f.id, label: f.name }))]} onChange={(v) => updateMetadata({ contact_list_filter_id: v === "none" ? null : v })} />
        <ConfigSelect label="Contactable Time Set" value={draft.metadata?.contactable_time_set_id || "none"} options={[{ value: "none", label: "No time set" }, ...timeSets.map((t) => ({ value: t.id, label: `${t.name} · ${t.timezone || "timezone"}` }))]} onChange={(v) => updateMetadata({ contactable_time_set_id: v === "none" ? null : v })} />
        <ConfigSelect label="Attempt Control" value={draft.attempt_control_id || "none"} options={[{ value: "none", label: "No attempt control" }, ...attemptControls.map((a) => ({ value: a.id, label: `${a.name} · ${title(a.reset_period || "daily")}` }))]} onChange={(v) => update({ attempt_control_id: v === "none" ? null : v })} />
      </div>
    </SettingCard>
    <MappingEditor campaign={draft} forms={forms} contactLists={contactLists} update={update} />
  </div>;
}

function parseTtsVoiceString(value) {
  const safe = String(value || "").trim();
  const parts = safe.split(".");
  return { provider: parts[0] || "", model: parts.length >= 3 ? parts[1] || "" : "", voiceName: safe };
}

function normalizeLocaleCode(code) {
  const match = String(code || "").replace(/_/g, "-").match(/^([a-zA-Z]{2,3})-([a-zA-Z]{2}|\d{3})$/);
  return match ? `${match[1].toLowerCase()}-${match[2].toUpperCase()}` : null;
}

function regionToFlag(region) {
  try {
    const normalized = String(region || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized)) return "";
    return String.fromCodePoint(...[...normalized].map((char) => 0x1f1e6 + (char.charCodeAt(0) - 65)));
  } catch (_) {
    return "";
  }
}

function CampaignAmdSettings({ amdConfig = {}, onChange = () => {} }) {
  const enabled = amdConfig.enabled === true;
  const action = amdConfig.machine_action || amdConfig.voicemailAction || "disconnect";
  const message = amdConfig.voicemail_message || amdConfig.message || DEFAULT_AMD_MESSAGE;
  const voiceConfig = amdConfig.voicemail_tts || {};
  const parsedVoice = parseTtsVoiceString(voiceConfig.voice || "");
  const [providers, setProviders] = useState([]);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [languageFilter, setLanguageFilter] = useState(voiceConfig.language || "");
  const [languageSearch, setLanguageSearch] = useState("");
  const [languagePopoverOpen, setLanguagePopoverOpen] = useState(false);
  const providerValue = voiceConfig.provider || parsedVoice.provider || providers[0]?.id || providers[0]?.provider || "";
  const selectedProvider = providers.find((p) => p.id === providerValue || p.provider === providerValue) || null;
  const models = (selectedProvider?.models || []).map((m) => typeof m === "string" ? { id: m, name: m, voices: [] } : { id: m.id || m.name || "", name: m.name || m.id || "", voices: m.voices || [] }).filter((m) => m.id);
  const modelValue = voiceConfig.model || parsedVoice.model || models[0]?.id || "";
  const allVoices = selectedProvider?.models?.flatMap((m) => typeof m === "object" && (!modelValue || (m.id || m.name) === modelValue) ? (m.voices || []) : []) || [];
  const languageOptions = useMemo(() => {
    const map = new Map();
    let langNames = null;
    let regionNames = null;
    try {
      langNames = new Intl.DisplayNames(undefined, { type: "language" });
      regionNames = new Intl.DisplayNames(undefined, { type: "region" });
    } catch (_) {}
    for (const voice of allVoices) {
      const normalized = normalizeLocaleCode(voice?.language);
      if (!normalized || map.has(normalized)) continue;
      const [lang, region] = normalized.split("-");
      let label = normalized.toUpperCase();
      try {
        const languageLabel = langNames?.of(lang) || lang.toUpperCase();
        const regionLabel = regionNames?.of(region) || region.toUpperCase();
        label = `${languageLabel} (${regionLabel})`;
      } catch (_) {}
      map.set(normalized, { value: normalized, label, flag: regionToFlag(region) });
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [allVoices]);
  const filteredLanguageOptions = useMemo(() => {
    if (!languageSearch.trim()) return languageOptions;
    const search = languageSearch.toLowerCase();
    return languageOptions.filter((option) => option.label.toLowerCase().includes(search) || option.value.toLowerCase().includes(search));
  }, [languageOptions, languageSearch]);
  const selectedLanguageInfo = useMemo(() => languageFilter ? languageOptions.find((opt) => opt.value === languageFilter) : null, [languageFilter, languageOptions]);
  const voices = allVoices.filter((v) => v?.id && (!languageFilter || normalizeLocaleCode(v?.language) === languageFilter));
  const voiceValue = voiceConfig.voice || parsedVoice.voiceName || "";
  useEffect(() => {
    let cancelled = false;
    async function loadVoices() {
      try {
        setTtsLoading(true);
        const response = await fetch("/api/tts/voices", { cache: "no-store" });
        const data = await response.json();
        if (!cancelled && response.ok && data?.ok) setProviders(data.providers || []);
      } catch (error) {
        console.error("Failed to load AMD TTS voices", error);
      } finally {
        if (!cancelled) setTtsLoading(false);
      }
    }
    loadVoices();
    return () => { cancelled = true; };
  }, []);
  const updateTts = (patch) => onChange({ voicemail_tts: { ...(amdConfig.voicemail_tts || {}), ...patch } });
  const handleLanguageChange = (selectedValue) => {
    const next = selectedValue === "__any__" ? "" : selectedValue;
    setLanguageFilter(next);
    updateTts({ language: next, voice: "" });
    setLanguagePopoverOpen(false);
  };
  const testVoice = async () => {
    if (!message.trim() || !voiceValue) return;
    try {
      setIsPlaying(true);
      const response = await fetch("/api/tts/speech", { method: "POST", headers: { "Content-Type": "application/json", "Cache-Control": "no-cache, no-store, must-revalidate" }, cache: "no-store", body: JSON.stringify({ text: message, voice: voiceValue, voice_api_key_ref: voiceConfig.voice_api_key_ref || "" }) });
      if (!response.ok) throw new Error("Failed to generate AMD voicemail preview");
      const audioUrl = URL.createObjectURL(await response.blob());
      const audio = new Audio(audioUrl);
      audio.onended = () => { setIsPlaying(false); URL.revokeObjectURL(audioUrl); };
      audio.onerror = () => { setIsPlaying(false); URL.revokeObjectURL(audioUrl); };
      await audio.play();
    } catch (error) {
      setIsPlaying(false);
      notify({ title: "Error", description: error.message || "Failed to test voice", variant: "error" });
    }
  };

  return <div className="mt-4 space-y-3 rounded-xl border bg-muted/20 p-3">
    <ToggleRow label="Answering Machine Detection" checked={enabled} onCheckedChange={(checked) => onChange({ enabled: checked === true })} />
    {enabled ? <div className="space-y-3 rounded-lg border bg-background/70 p-3">
      <ConfigSelect label="Answering machine action" value={action} options={AMD_ACTION_OPTIONS} onChange={(value) => onChange({ machine_action: value, voicemailAction: value })} />
      {action === "leave_message" ? <div className="space-y-3">
        <div>
          <Label>Voicemail message</Label>
          <Textarea className="mt-2" rows={4} maxLength={3000} value={message} onChange={(event) => onChange({ voicemail_message: event.target.value, message: event.target.value })} placeholder="Message to leave on answering machine" />
          <p className="mt-1 text-xs text-muted-foreground">Text or SSML left after answering machine detection. Supports campaign/contact variables.</p>
        </div>
        <ConfigSelect label="Provider" value={providerValue} options={providers.map((p) => ({ value: p.id || p.provider, label: p.name || p.provider || p.id }))} onChange={(value) => { setLanguageFilter(""); updateTts({ provider: value, model: "", voice: "", language: "" }); }} />
        <ConfigSelect label="Model" value={modelValue} options={models.map((m) => ({ value: m.id, label: m.name || m.id }))} onChange={(value) => { setLanguageFilter(""); updateTts({ model: value, voice: "", language: "" }); }} />
        {languageOptions.length > 0 || languageFilter ? <div>
          <Label>Language Filter</Label>
          <Popover open={languagePopoverOpen} onOpenChange={setLanguagePopoverOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" role="combobox" className="w-full mt-1 justify-between" disabled={ttsLoading}>
                <div className="flex items-center gap-2">
                  {selectedLanguageInfo ? <>
                    <span>{selectedLanguageInfo.flag}</span>
                    <span>{selectedLanguageInfo.label}</span>
                  </> : <>
                    <IconWorld className="h-4 w-4" />
                    <span>{languageFilter || "All languages"}</span>
                  </>}
                </div>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search languages..." value={languageSearch} onValueChange={setLanguageSearch} className="h-9" />
                <CommandEmpty>No language found.</CommandEmpty>
                <CommandGroup className="max-h-[300px] overflow-auto">
                  <CommandItem value="__any__" onSelect={() => handleLanguageChange("__any__")}>
                    <IconCheck className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${!languageFilter ? "opacity-100" : "opacity-0"}`} />
                    <IconWorld className="size-4 mr-2" />
                    <span>Any</span>
                  </CommandItem>
                  {filteredLanguageOptions.map((opt) => <CommandItem key={opt.value} value={`${opt.label}-${opt.value}`} onSelect={() => handleLanguageChange(opt.value)}>
                    <IconCheck className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${languageFilter === opt.value ? "opacity-100" : "opacity-0"}`} />
                    <span className="mr-2">{opt.flag}</span>
                    <span>{opt.label}</span>
                  </CommandItem>)}
                </CommandGroup>
              </Command>
            </PopoverContent>
          </Popover>
          <p className="text-xs text-muted-foreground mt-1">Filter voices by language ({languageOptions.length} language{languageOptions.length !== 1 ? "s" : ""} available)</p>
        </div> : null}
        <ConfigSelect label="Voice" value={voiceValue} options={voices.map((voice) => ({ value: voice.id, label: voice.language ? `${voice.name || voice.id} (${voice.language})` : (voice.name || voice.id) }))} onChange={(value) => updateTts({ provider: providerValue, model: modelValue, language: languageFilter, voice: value })} />
        {languageFilter ? <p className="text-xs text-muted-foreground -mt-2">Showing {voices.length} voice{voices.length !== 1 ? "s" : ""} for {selectedLanguageInfo?.label || languageFilter}</p> : null}
        <Button type="button" variant="outline" className="w-full" onClick={testVoice} disabled={ttsLoading || !message.trim() || !voiceValue}>{isPlaying ? <IconPlayerStop className="mr-2 h-4 w-4" /> : <IconPlayerPlay className="mr-2 h-4 w-4" />}Test Voice</Button>
      </div> : <p className="rounded-lg border border-dashed bg-muted/25 p-3 text-xs text-muted-foreground">Machine calls will be disconnected immediately after answering machine detection.</p>}
    </div> : null}
  </div>;

}


function DispositionCodesSettingsForm({ dispositionCode, wrapupCodes = [], campaigns = [], saveDispositionCode, saving, registerHeaderSaveAction }) {
  const [draft, setDraft] = useState(() => dispositionCode || defaultDispositionCode(wrapupCodes));
  useEffect(() => { setDraft(dispositionCode || defaultDispositionCode(wrapupCodes)); }, [dispositionCode, wrapupCodes]);
  const classification = draft.classification || "none";
  const update = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const save = useCallback(() => saveDispositionCode({ ...draft, business_category: classification === "right_party_contact" ? draft.business_category : "none", retry_eligible: classification === "retry" ? draft.retry_eligible !== false : false, requires_callback: classification === "retry" ? draft.requires_callback === true : false }), [classification, draft, saveDispositionCode]);
  useEffect(() => { registerHeaderSaveAction({ section: "disposition-codes", label: "Save mapping", disabled: saving || !draft.wrapup_code_id, busy: saving, onSave: save }); return () => registerHeaderSaveAction(null); }, [draft, saving, save, registerHeaderSaveAction]);
  const selectedWrapup = wrapupCodes.find((code) => code.id === draft.wrapup_code_id);
  const wrapupOptions = wrapupCodes.length ? wrapupCodes.map((code) => ({ value: code.id, label: code.name })) : [{ value: "default", label: "No wrap-up codes loaded", disabled: true }];
  const activeCampaignOptions = campaigns.filter(isActiveCampaignConfig);
  const campaignOptions = [{ value: "global", label: "Global default" }, ...activeCampaignOptions.map((campaign) => ({ value: campaign.id, label: campaign.name }))];
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 text-sm">
    <SettingCard title="Wrap-up source" icon={IconListDetails} subtitle="Choose the existing wrap-up code agents see, then map it to a campaign disposition outcome.">
      <ConfigSelect label="Wrap-up code" value={draft.wrapup_code_id || wrapupOptions[0]?.value} options={wrapupOptions} onChange={(value) => update({ wrapup_code_id: value })} />
      {selectedWrapup ? <div className="mt-3 rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground"><div className="font-medium text-foreground">{selectedWrapup.name}</div><div className="mt-1">{selectedWrapup.description || "No description"}</div></div> : null}
      <div className="mt-3"><ConfigSelect label="Scope" value={draft.campaign_id || "global"} options={campaignOptions} onChange={(value) => update({ campaign_id: value === "global" ? null : value })} /></div>
    </SettingCard>
    <SettingCard title="Disposition outcome" icon={IconSparkles} subtitle="Classification decides what happens to the outbound record">
      <ConfigSelect label="Classification" value={classification} options={[{ value: "none", label: "Complete only" }, { value: "right_party_contact", label: "Right Party Contact" }, { value: "retry", label: "Retry / Callback" }, { value: "number_uncallable", label: "Number Uncallable" }, { value: "contact_uncallable", label: "Contact Uncallable / DNC" }]} onChange={(value) => update({ classification: value })} />
      {classification === "right_party_contact" ? <div className="mt-3"><ConfigSelect label="Business Category" value={draft.business_category || "none"} options={[{ value: "success", label: "Success" }, { value: "neutral", label: "Neutral" }, { value: "failure", label: "Failure" }, { value: "none", label: "None" }]} onChange={(value) => update({ business_category: value })} /></div> : null}
      {classification === "retry" ? <div className="mt-3 space-y-3 rounded-xl border bg-muted/20 p-3"><ToggleRow label="Retry eligible" checked={draft.retry_eligible !== false} onCheckedChange={(checked) => update({ retry_eligible: checked })} /><ToggleRow label="Requires callback date/time" checked={draft.requires_callback === true} onCheckedChange={(checked) => update({ requires_callback: checked })} /></div> : null}
      <div className="mt-3"><ToggleRow label="Active" checked={draft.status === "active"} onCheckedChange={(checked) => update(activeToggleStatusPatch(checked))} /><p className="mt-2 text-xs text-muted-foreground">Active disposition mappings are available for campaign workflows.</p></div>
    </SettingCard>
  </div>;
}

function AttemptControlSettingsForm({ attemptControl, outboundSettings, schema, saveAttemptControl, saving, registerHeaderSaveAction }) {
  const globalMaxAttempts = normalizeGlobalMaxAttempts(outboundSettings?.global_max_attempts ?? outboundSettings?.globalMaxAttempts);
  const [draft, setDraft] = useState(() => normalizeAttemptControlLimits(attemptControl || defaultAttemptControl(), globalMaxAttempts));
  useEffect(() => setDraft(normalizeAttemptControlLimits(attemptControl || defaultAttemptControl(), globalMaxAttempts)), [attemptControl, globalMaxAttempts]);
  const timezoneOptions = useMemo(() => { const supported = typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : FALLBACK_TIME_ZONES; const now = new Date(); return Array.from(new Set([draft.timezone || "Europe/Warsaw", ...FALLBACK_TIME_ZONES, ...supported].filter(Boolean))).sort().map((zone) => timeZoneOptionFor(zone, now)); }, [draft.timezone]);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const recallRules = Array.isArray(draft.recall_rules) ? draft.recall_rules : [];
  const phoneTypeRules = Array.isArray(draft.phone_type_rules) ? draft.phone_type_rules : [];
  const maxContact = Number(draft.max_attempts_per_contact || 0);
  const maxNumber = Number(draft.max_attempts_per_number || 0);
  const validationWarnings = [
    ...recallRules.filter((row) => Number(row.attempts || 0) > maxContact).map((row) => `${title(row.outcome)} recall attempts exceed max attempts per contact.`),
    ...phoneTypeRules.flatMap((group) => (group.rules || []).filter((row) => Number(row.attempts || 0) > maxNumber).map((row) => `${title(group.phone_type)} / ${title(row.outcome)} attempts exceed max attempts per number.`)),
  ];
  const save = useCallback(() => saveAttemptControl(normalizeAttemptControlLimits(draft, globalMaxAttempts)), [draft, globalMaxAttempts, saveAttemptControl]);
  useEffect(() => { registerHeaderSaveAction({ section: "attempt-controls", label: "Save attempt control", disabled: saving || !draft.name?.trim(), busy: saving, onSave: save }); return () => registerHeaderSaveAction(null); }, [draft, saving, save, registerHeaderSaveAction]);
  const updateRecall = (idx, patch) => update({ recall_rules: recallRules.map((row, i) => i === idx ? { ...row, ...patch } : row) });
  const addRecall = () => update({ recall_rules: [...recallRules, { outcome: "busy", attempts: 1, minutes_between_attempts: 30 }] });
  const removeRecall = (idx) => update({ recall_rules: recallRules.filter((_, i) => i !== idx) });
  const updatePhoneGroup = (idx, patch) => update({ phone_type_rules: phoneTypeRules.map((group, i) => i === idx ? { ...group, ...patch } : group) });
  const addPhoneGroup = () => update({ phone_type_rules: [...phoneTypeRules, { phone_type: "mobile", rules: [{ outcome: "busy", attempts: 1, minutes_between_attempts: 30 }] }] });
  const removePhoneGroup = (idx) => update({ phone_type_rules: phoneTypeRules.filter((_, i) => i !== idx) });
  const updatePhoneRule = (groupIdx, ruleIdx, patch) => updatePhoneGroup(groupIdx, { rules: (phoneTypeRules[groupIdx]?.rules || []).map((row, i) => i === ruleIdx ? { ...row, ...patch } : row) });
  const addPhoneRule = (groupIdx) => updatePhoneGroup(groupIdx, { rules: [...(phoneTypeRules[groupIdx]?.rules || []), { outcome: "no_answer", attempts: 1, minutes_between_attempts: 120 }] });
  const removePhoneRule = (groupIdx, ruleIdx) => updatePhoneGroup(groupIdx, { rules: (phoneTypeRules[groupIdx]?.rules || []).filter((_, i) => i !== ruleIdx) });
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconAdjustmentsHorizontal} title={draft.id ? draft.name : "Attempt control configuration"} subtitle="Attempt caps, reset period, timezone, and recall cadence"><InputBlock label="Attempt control name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" rows={2} value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} /></div><div className="mt-3 grid gap-3"><ToggleRow label="Active" checked={draft.status === "active"} onCheckedChange={(checked) => update(activeToggleStatusPatch(checked))} helper="Active attempt controls are visible on campaign configuration." /><ConfigSelect label="Reset period" value={draft.reset_period || "daily"} options={schema.attemptResetPeriods || ["daily", "weekly", "monthly", "campaign", "lifetime"]} onChange={(v) => update({ reset_period: v })} /><TimeZoneSelect label="Time Zone" value={draft.timezone || "Europe/Warsaw"} options={timezoneOptions} onChange={(v) => update({ timezone: v })} /></div><div className="mt-3 grid grid-cols-2 gap-3"><InputBlock label="Max attempts / contact" type="number" min={0} max={globalMaxAttempts} value={normalizeAttemptCount(draft.max_attempts_per_contact ?? 4, 4, globalMaxAttempts)} onChange={(v) => update({ max_attempts_per_contact: normalizeAttemptCount(v, 0, globalMaxAttempts) })} /><InputBlock label="Max attempts / number" type="number" min={0} max={globalMaxAttempts} value={normalizeAttemptCount(draft.max_attempts_per_number ?? 2, 2, globalMaxAttempts)} onChange={(v) => update({ max_attempts_per_number: normalizeAttemptCount(v, 0, globalMaxAttempts) })} /></div></SettingCard><SettingCard icon={IconRotateClockwise} title="Recall controls" subtitle="Outcome-level cadence similar to Genesys attempt controls"><RecallRows rows={recallRules} maxAttempts={globalMaxAttempts} updateRow={updateRecall} removeRow={removeRecall} addRow={addRecall} /></SettingCard><SettingCard icon={IconPhoneCall} title="Recall controls per phone type" subtitle="Override recall cadence for specific contact method groups"><div className="space-y-3">{phoneTypeRules.map((group, groupIdx) => <div key={groupIdx} className="rounded-xl border bg-muted/25 p-3"><div className="mb-3 flex items-center gap-2"><div className="flex-1"><ConfigSelect bare value={group.phone_type || "mobile"} options={PHONE_TYPES} onChange={(v) => updatePhoneGroup(groupIdx, { phone_type: v })} /></div><Button type="button" variant="ghost" size="sm" onClick={() => removePhoneGroup(groupIdx)}><IconTrash className="mr-2 h-4 w-4" />Remove</Button></div><RecallRows rows={group.rules || []} maxAttempts={globalMaxAttempts} updateRow={(idx, patch) => updatePhoneRule(groupIdx, idx, patch)} removeRow={(idx) => removePhoneRule(groupIdx, idx)} addRow={() => addPhoneRule(groupIdx)} compact /></div>)}<Button type="button" size="sm" variant="outline" onClick={addPhoneGroup}><IconPlus className="mr-2 h-4 w-4" />Add phone type</Button></div></SettingCard>{validationWarnings.length ? <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200"><div className="font-semibold">Validation hints</div><ul className="mt-2 list-disc space-y-1 pl-4">{validationWarnings.map((warning, idx) => <li key={idx}>{warning}</li>)}</ul></div> : <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-200">Recall attempts are within the configured max attempt caps.</div>}</div>;
}

function RecallRows({ rows, updateRow, removeRow, addRow, compact = false, maxAttempts = 5 }) {
  return <div className="space-y-2">{rows.map((row, idx) => <div key={idx} className="space-y-3 rounded-xl border bg-background/70 p-3 shadow-sm"><div className="grid grid-cols-[minmax(0,1fr)_36px] items-end gap-2"><ConfigSelect label="Outcome" value={row.outcome || "busy"} options={RECALL_OUTCOMES} onChange={(v) => updateRow(idx, { outcome: v })} /><Button type="button" variant="ghost" size="icon" className="mb-0 h-10 w-10 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600" onClick={() => removeRow(idx)} title="Remove recall rule"><IconX className="h-4 w-4" /></Button></div><div className="grid grid-cols-2 gap-2"><InputBlock label="Attempts" type="number" min={0} max={maxAttempts} value={normalizeAttemptCount(row.attempts ?? 1, 1, maxAttempts)} onChange={(v) => updateRow(idx, { attempts: normalizeAttemptCount(v, 0, maxAttempts) })} /><InputBlock label="Minutes" type="number" min={0} value={Math.max(0, Number(row.minutes_between_attempts ?? row.minutesBetweenAttempts ?? 30) || 0)} onChange={(v) => updateRow(idx, { minutes_between_attempts: Math.max(0, Number(v) || 0) })} /></div></div>)}<Button type="button" size="sm" variant="outline" onClick={addRow}><IconPlus className="mr-2 h-4 w-4" />Add recall rule</Button></div>;
}

function OutboundSettingsForm({ settings, inventoryNumbers, saveOutboundSettings, saving, registerHeaderSaveAction }) {
  const [draft, setDraft] = useState(settings || defaultOutboundSettings());
  useEffect(() => { setDraft(settings || defaultOutboundSettings()); }, [settings]);
  const timezoneOptions = useMemo(() => { const supported = typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : FALLBACK_TIME_ZONES; const now = new Date(); return Array.from(new Set([draft.callable_window?.timezone || "Europe/Warsaw", ...FALLBACK_TIME_ZONES, ...supported].filter(Boolean))).sort().map((zone) => timeZoneOptionFor(zone, now)); }, [draft.callable_window?.timezone]);
  const callableDays = normalizedCallableDays(draft);
  const allowedNumberOptions = (inventoryNumbers || []).map((item) => ({ value: item.phone_number, label: item.connection_name ? `${item.phone_number} · ${String(item.connection_name).slice(0, 20)}${String(item.connection_name).length > 20 ? "…" : ""}` : item.phone_number }));
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const updateWindow = (patch) => update({ callable_window: { ...(draft.callable_window || {}), ...patch } });
  const toggleCallableDay = (day, checked) => {
    const next = checked ? [...new Set([...callableDays, day])] : callableDays.filter((item) => item !== day);
    update({ callable_days: WEEKDAYS.map((item) => item.id).filter((item) => next.includes(item)) });
  };
  const save = useCallback(() => saveOutboundSettings(draft), [draft, saveOutboundSettings]);
  useEffect(() => { registerHeaderSaveAction({ section: "settings", label: "Save settings", disabled: saving, busy: saving, onSave: save }); return () => registerHeaderSaveAction(null); }, [saving, save, registerHeaderSaveAction]);
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconSettings} title="Outbound settings" subtitle="Global dialing limits and pacing defaults"><div className="grid grid-cols-2 gap-3"><InputBlock label="Max calls per agent" type="number" value={draft.max_calls_per_agent ?? 1} onChange={(v) => update({ max_calls_per_agent: Number(v) || 1 })} /><InputBlock label="Max lines" type="number" value={draft.max_lines ?? 10} onChange={(v) => update({ max_lines: Number(v) || 1 })} /><InputBlock label="Max line utilization %" type="number" value={draft.max_line_utilization_percent ?? 90} onChange={(v) => update({ max_line_utilization_percent: Number(v) || 0 })} /><InputBlock label="Max CPS" type="number" value={draft.max_cps ?? draft.maxCps ?? 50} onChange={(v) => update({ max_cps: Number(v) || 50 })} /><InputBlock label="Global Max Attempts" type="number" min={1} max={100} value={normalizeGlobalMaxAttempts(draft.global_max_attempts ?? draft.globalMaxAttempts)} onChange={(v) => update({ global_max_attempts: normalizeGlobalMaxAttempts(v) })} /><InputBlock label="Dial Timeout (sec)" type="number" min={15} value={normalizeDialTimeoutSecs(draft.dial_timeout_secs ?? draft.dialTimeoutSecs, 30)} onChange={(v) => update({ dial_timeout_secs: normalizeDialTimeoutSecs(v, 30) })} /></div></SettingCard><SettingCard icon={IconPhoneCall} title="Allowed Numbers" subtitle="Numbers enabled for campaigns to be used as CLI"><MultiSelect values={Array.isArray(draft.allowed_numbers) ? draft.allowed_numbers : []} options={allowedNumberOptions} emptyLabel="No active numbers found in inventory." onChange={(values) => update({ allowed_numbers: values })} showSelectedBadges={false} /></SettingCard><SettingCard icon={IconShieldCheck} title="Compliance" subtitle="Dialer compliance thresholds"><InputBlock label="Abandon threshold seconds" type="number" value={draft.compliance_abandon_threshold_seconds ?? 2} onChange={(v) => update({ compliance_abandon_threshold_seconds: Number(v) || 0 })} /></SettingCard><SettingCard icon={IconClockHour4} title="Time Zone Settings" subtitle="Defaults used when creating new Time Sets"><div className="space-y-3"><div className="grid grid-cols-2 gap-3"><InputBlock label="Default callable start" type="time" value={draft.callable_window?.earliest || "09:00"} onChange={(v) => updateWindow({ earliest: v })} /><InputBlock label="Default callable end" type="time" value={draft.callable_window?.latest || "20:00"} onChange={(v) => updateWindow({ latest: v })} /></div><div><Label>Callable days</Label><div className="mt-2 grid grid-cols-2 gap-2">{WEEKDAYS.map((day) => <label key={day.id} className="flex items-center gap-2 rounded-lg border bg-background/70 px-3 py-2 text-sm"><Checkbox checked={callableDays.includes(day.id)} onCheckedChange={(checked) => toggleCallableDay(day.id, checked === true)} />{day.label}</label>)}</div></div><TimeZoneSelect label="Default time zone" value={draft.callable_window?.timezone || "Europe/Warsaw"} options={timezoneOptions} onChange={(v) => updateWindow({ timezone: v })} /></div></SettingCard></div>;
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
  const validationCandidate = useMemo(() => ({ ...draft, metadata: { ...(draft.metadata || {}), ...(csvPreview.headers.length ? { csv_import_settings: importMetadata } : {}) } }), [draft, csvPreview.headers.length, importMetadata]);
  const validationAllowed = canValidateContactList(validationCandidate);
  const validationMessage = contactListValidationMessage(validationCandidate);
  const importReadiness = useMemo(() => getCsvImportReadiness(csv, csvPreview.headers, csvImportConfig), [csv, csvPreview.headers, csvImportConfig]);
  const updateSelectedFieldType = (fieldName, type) => update({ custom_field_schema: upsertFieldSchemaType(draft.custom_field_schema, fieldName, type) });
  const save = useCallback(() => saveList({ ...draft, status: draft.status === "validated" && validationAllowed ? "validated" : "draft", custom_field_schema: selectedFieldSchema.length ? selectedFieldSchema : draft.custom_field_schema, metadata: { ...(draft.metadata || {}), ...(csvPreview.headers.length ? { csv_import_settings: importMetadata } : {}) } }), [draft, validationAllowed, selectedFieldSchema, csvPreview.headers.length, importMetadata, saveList]);
  const importCsv = async () => { if (!csv.trim()) return notify({ title: "Choose a CSV first", description: "Select or drop a CSV file before importing.", variant: "warning" }); if (!importReadiness.ready) return notify({ title: "Preview mapping required", description: importReadiness.message, variant: "warning" }); setImporting(true); try { const savedList = await save(); if (!savedList?.id) return; const data = await api(`${API}/contact-lists/${savedList.id}/import`, { method: "POST", body: JSON.stringify({ csv, metadata: { ...importMetadata, field_schema: selectedFieldSchema } }) }); notify({ title: "CSV imported", description: `${data.totalRows} rows, ${data.validPhones} valid mapped phone/WhatsApp numbers`, variant: "success" }); await onImported(); } catch (err) { notify({ title: "CSV import failed", description: err.message, variant: "error" }); } finally { setImporting(false); } };
  useEffect(() => { registerHeaderSaveAction({ section: "contact-lists", label: "Save contact list", disabled: saving || !draft.name?.trim(), busy: saving, onSave: save }); return () => registerHeaderSaveAction(null); }, [draft, saving, save, registerHeaderSaveAction]);
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconDatabase} title={draft.id ? draft.name : "Contact list configuration"} subtitle="Persisted list details"><InputBlock label="List name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} rows={2} /></div><div className="mt-3"><ToggleRow label="Active" checked={draft.status === "validated"} disabled={!validationAllowed} onCheckedChange={(checked) => update(activeToggleStatusPatch(checked && validationAllowed, "validated", "draft"))} /><p className={`mt-2 text-xs ${validationAllowed ? "text-muted-foreground" : "text-amber-600 dark:text-amber-300"}`}>{validationMessage}</p></div></SettingCard><CsvUploadCard title="CSV upload" description="Choose a CSV, preview the first 10 records, select import columns, and map at least one contact method. Campaign-specific validation will later require Number/WhatsApp for voice/WhatsApp and Email for email campaigns." csv={csv} setCsv={setCsv} fileName={csvFileName} setFileName={setCsvFileName} preview={csvPreview} importConfig={csvImportConfig} setImportConfig={setCsvImportConfig} onImport={importCsv} importing={importing} disabled={!draft.id} buttonLabel="Upload" readiness={importReadiness} importedPreviewEndpoint={draft.id ? `${API}/contact-lists/${draft.id}/preview` : null} hasImportedPreview={Number(draft.record_count || 0) > 0} importedPreviewTitle="Imported contact list preview" importedPreviewDescription="Read-only preview of up to 10 records imported into the database." /><SettingCard icon={IconForms} title="Field schema" subtitle="Fields come from selected CSV import columns and are stored/searchable in contact record JSONB.">{selectedFieldSchema.length ? <div className="grid gap-2">{selectedFieldSchema.map((field) => <div key={field.name} className="grid grid-cols-[minmax(0,1fr)_140px] items-center gap-2 rounded-lg border bg-background/70 p-2"><div className="min-w-0"><div className="truncate font-mono text-xs">{field.name}</div><div className="text-[11px] text-muted-foreground">Imported CSV column</div></div><ConfigSelect bare value={field.type || "text"} options={schema.contactFieldTypes} onChange={(v) => updateSelectedFieldType(field.name, v)} /></div>)}</div> : <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No import fields selected yet. Choose a CSV, open the preview, and select columns to populate this schema.</div>}</SettingCard></div>;
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
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconShieldCheck} title={draft.id ? draft.name : "DNC list configuration"} subtitle="Persisted suppression list"><InputBlock label="DNC list name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} rows={2} /></div><div className="mt-3 grid gap-3"><ToggleRow label="Active" checked={draft.status === "active"} onCheckedChange={(checked) => update(activeToggleStatusPatch(checked))} /><ConfigSelect label="Match strategy" value={draft.match_strategy || "phone"} options={["phone", "email", "phone_or_email"]} onChange={(v) => update({ match_strategy: v })} /><p className="text-xs text-muted-foreground">Active DNC lists are visible on campaign configuration.</p></div></SettingCard><CsvUploadCard title="DNC CSV upload" description="Choose a CSV, preview the first 10 records, and select valid suppression columns for the current match strategy." csv={csv} setCsv={setCsv} fileName={csvFileName} setFileName={setCsvFileName} preview={csvPreview} importConfig={csvImportConfig} setImportConfig={setCsvImportConfig} onImport={importCsv} importing={importing} disabled={false} buttonLabel="Upload" readiness={importReadiness} previewTitle="DNC CSV preview" previewDescription="Previewing up to 10 records. Columns are enabled only when sample values match the DNC strategy." showMappings={false} dncMatchStrategy={draft.match_strategy || "phone"} dncColumnStats={dncColumnStats} importedPreviewEndpoint={draft.id ? `${API}/dnc-lists/${draft.id}/preview` : null} hasImportedPreview={Number(draft.record_count || 0) > 0} importedPreviewTitle="Imported DNC preview" importedPreviewDescription="Read-only preview of up to 10 suppression entries stored in the database." /></div>;
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
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconFilter} title={draft.id ? draft.name : "Filter configuration"} subtitle="Persisted metadata; test current unsaved conditions before saving"><InputBlock label="Name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" rows={2} value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} /></div><div className="mt-3 grid gap-3"><ToggleRow label="Active" checked={draft.status === "active"} onCheckedChange={(checked) => update(activeToggleStatusPatch(checked))} /><ConfigSelect label="Target contact list" value={draft.contact_list_id || contactListOptions[0]?.value} options={contactListOptions} onChange={updateContactList} /><p className="text-xs text-muted-foreground">Active filters are visible on campaign configuration.</p></div></SettingCard><SettingCard icon={IconListDetails} title="Conditions" subtitle="Fields are loaded from the selected contact list import schema and row data"><FilterConditionsEditor conditions={conditions} conditionFieldOptions={conditionFieldOptions} firstField={firstField} operators={operators} selectedList={selectedList} updateCondition={updateCondition} removeCondition={removeCondition} addCondition={addCondition} /><div className="mt-3 flex flex-wrap items-center gap-2"><Button type="button" className="mt-0" size="sm" variant="outline" disabled={!firstField} onClick={addCondition}><IconPlus className="mr-2 h-4 w-4" />Add rule</Button><Button type="button" size="sm" onClick={openTestPreview} disabled={testing || !draft.contact_list_id} className={neutralActionClass}>{testing ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconEye className="mr-2 h-4 w-4" />}Test filter</Button></div></SettingCard><FilterTestPreviewSheet open={previewOpen} onOpenChange={setPreviewOpen} filterName={draft.name} selectedList={selectedList} conditions={conditions} conditionFieldOptions={conditionFieldOptions} firstField={firstField} operators={operators} updateCondition={updateCondition} removeCondition={removeCondition} addCondition={addCondition} result={testResult} testing={testing} onTest={runFilterTest} /></div>;
}

function FilterConditionsEditor({ conditions, conditionFieldOptions, firstField, operators, selectedList, updateCondition, removeCondition, addCondition, showEmptyAddButton = false }) {
  return <div className="space-y-2">{conditions.map((row, idx) => <div key={idx} className="rounded-xl border bg-muted/25 p-2"><div className="grid gap-2"><ConfigSelect bare value={row.field || firstField || conditionFieldOptions[0]?.value} options={conditionFieldOptions} onChange={(v) => updateCondition(idx, { field: v })} /><ConfigSelect bare value={row.operator || "is present"} options={operators} onChange={(v) => updateCondition(idx, { operator: v })} /><Input value={row.value || ""} placeholder="Value (optional)" onChange={(e) => updateCondition(idx, { value: e.target.value })} /><Button type="button" variant="ghost" size="sm" onClick={() => removeCondition(idx)}><IconX className="mr-2 h-4 w-4" />Remove</Button></div></div>)}{!conditions.length ? <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{selectedList ? (firstField ? "No filter rules yet. Add a rule to start narrowing this contact list." : "This contact list does not have imported fields yet. Import CSV columns before adding filter rules.") : "Select a target contact list before adding rules."}</div> : null}{showEmptyAddButton && !conditions.length && firstField ? <Button type="button" className="mt-3" size="sm" variant="outline" onClick={addCondition}><IconPlus className="mr-2 h-4 w-4" />Add rule</Button> : null}</div>;
}

function normalizePreviewScannedRecords(result = {}, selectedList = {}) {
  const scanLimit = Number(result?.scanLimit || 0);
  const limited = Boolean(result?.limited || result?.capped);
  const resultRecordCount = Number(result?.contactList?.record_count || 0);
  const listRecordCount = Number(selectedList?.record_count || resultRecordCount || 0);
  if (!limited && listRecordCount > 0) return listRecordCount;
  const candidates = [result?.scannedRecords, result?.totalRecordsConsidered, result?.totalRecords];
  const scanned = candidates.map((value) => Number(value)).find((value) => Number.isFinite(value) && value >= 0);
  if (!limited && scanLimit && scanned === scanLimit && listRecordCount > 0 && listRecordCount < scanLimit) return listRecordCount;
  return scanned ?? listRecordCount ?? 0;
}

function FilterTestPreviewSheet({ open, onOpenChange, filterName, selectedList, conditions, conditionFieldOptions, firstField, operators, updateCondition, removeCondition, addCondition, result, testing, onTest }) {
  const columns = result?.columns?.length ? result.columns : conditionFieldOptions.filter((option) => !option.disabled).map((option) => option.value);
  const rows = result?.sampleRows || [];
  const scanned = normalizePreviewScannedRecords(result, selectedList);
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
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="bottom" showCloseButton={false} className="max-h-[calc(100vh-1rem)] gap-0 overflow-hidden rounded-t-3xl bg-background p-0"><SheetHeader className="border-b bg-card/95 px-6 py-4 shadow-sm"><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 to-violet-500/20 text-sky-600 shadow-sm shadow-sky-500/10 dark:text-sky-300"><IconFilter className="h-5 w-5" /></span><div className="min-w-0"><SheetTitle className="truncate text-base">Test filter{filterName ? ` · ${filterName}` : ""}</SheetTitle><SheetDescription>Preview current unsaved conditions against {selectedList?.name || "the selected contact list"}. Changes here sync back to Context Settings.</SheetDescription></div></div></div><div className="flex shrink-0 flex-wrap items-center gap-2"><Badge variant="outline" className={valid ? "border-emerald-500/45 bg-emerald-500/10 px-3 py-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300" : "border-amber-500/45 bg-amber-500/10 px-3 py-1 text-sm font-semibold text-amber-700 dark:text-amber-300"}>{valid ? "Validated" : "Needs setup"}</Badge><Badge variant="outline" className={limited ? "border-amber-500/45 bg-amber-500/10 px-3 py-1 text-sm font-semibold text-amber-700 dark:text-amber-300" : "border-sky-500/45 bg-sky-500/10 px-3 py-1 text-sm font-semibold text-sky-700 dark:text-sky-300"}><span className="mr-1 text-[10px] uppercase tracking-wide opacity-75">Scanned</span>{scannedDisplay}</Badge><Badge variant="outline" className="border-emerald-500/45 bg-emerald-500/10 px-3 py-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300"><span className="mr-1 text-[10px] uppercase tracking-wide opacity-75">{limited ? "Matched in scan" : "Matching"}</span>{matching.toLocaleString()}</Badge>{limited && scanLimit ? <Badge variant="outline" className="border-amber-500/45 bg-amber-500/10 px-3 py-1 text-sm font-semibold text-amber-700 dark:text-amber-300"><span className="mr-1 text-[10px] uppercase tracking-wide opacity-75">Limit</span>{scanLimit.toLocaleString()}</Badge> : null}<Button type="button" size="sm" variant="outline" onClick={onTest} disabled={testing} className="bg-background/80">{testing ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconRefresh className="mr-2 h-4 w-4" />}Apply filter</Button><Button type="button" size="sm" onClick={() => onOpenChange?.(false)} className={neutralActionClass}><IconCheck className="mr-2 h-4 w-4" />Update</Button></div></div></SheetHeader><div className="grid max-h-[calc(100vh-11rem)] gap-4 overflow-auto p-6 lg:grid-cols-[360px_minmax(0,1fr)]"><div className="space-y-3"><div className="rounded-2xl border bg-background/90 p-4 shadow-sm"><div className="mb-3 text-sm font-semibold">Preview conditions</div><FilterConditionsEditor conditions={conditions} conditionFieldOptions={conditionFieldOptions} firstField={firstField} operators={operators} selectedList={selectedList} updateCondition={updateCondition} removeCondition={removeCondition} addCondition={addCondition} showEmptyAddButton /></div>{errors.length ? <div className="rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200"><div className="font-semibold">Validation</div><ul className="mt-2 list-disc space-y-1 pl-4">{errors.map((error, idx) => <li key={idx}>{error}</li>)}</ul></div> : <div className="rounded-2xl border border-emerald-500/35 bg-emerald-500/10 p-4 text-sm text-emerald-800 dark:text-emerald-200">Filter is valid for the selected contact list fields.</div>}</div><div className="min-w-0 rounded-2xl border bg-background/90 shadow-sm"><div className="border-b px-4 py-3"><div className="text-sm font-semibold">Sample matching rows</div><p className="text-xs text-muted-foreground">Showing up to 10 matching records from imported row_data. {result ? countSummary : "Run the test to scan this list."}</p></div><div className="overflow-auto"><Table><TableHeader><TableRow className="bg-muted/50 hover:bg-muted/50">{columns.length ? columns.map((column) => <TableHead key={column} className="min-w-44 font-mono text-xs">{column}</TableHead>) : <TableHead>No fields</TableHead>}</TableRow></TableHeader><TableBody>{rows.length ? rows.map((record, idx) => <TableRow key={idx} className="h-9">{columns.map((column) => <TableCell key={`${idx}-${column}`} className="h-9 max-w-64 truncate py-2 text-xs" title={record[column]}>{record[column] || "—"}</TableCell>)}</TableRow>) : <TableRow className="h-9"><TableCell colSpan={Math.max(columns.length, 1)} className="h-9 py-2 text-center text-muted-foreground">{testing ? "Testing filter…" : valid ? "No records match these conditions." : "Fix validation issues and apply the filter to preview rows."}</TableCell></TableRow>}{placeholderRows.map((_, idx) => <TableRow key={`filter-placeholder-${idx}`} className="h-9 hover:bg-transparent"><TableCell colSpan={Math.max(columns.length, 1)} className="h-9 py-2 text-xs text-transparent" aria-hidden="true">—</TableCell></TableRow>)}</TableBody></Table></div></div></div></SheetContent></Sheet>;
}

function TimeSetSettingsForm({ timeSet, outboundSettings, saveTimeSet, saving, registerHeaderSaveAction, view, setView }) {
  const [draft, setDraft] = useState(timeSet || defaultTimeSetFromSettings(outboundSettings));
  useEffect(() => { setDraft(timeSet || defaultTimeSetFromSettings(outboundSettings)); }, [timeSet, outboundSettings]);
  const timezoneOptions = useMemo(() => {
    const supported = typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : FALLBACK_TIME_ZONES;
    const now = new Date();
    return Array.from(new Set([draft.timezone || "Europe/Warsaw", ...FALLBACK_TIME_ZONES, ...supported].filter(Boolean))).sort().map((zone) => timeZoneOptionFor(zone, now));
  }, [draft.timezone]);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const windows = useMemo(() => (draft.windows || []).map(normalizeWindowTimes), [draft.windows]);
  const dayWindow = (day) => normalizeWindowTimes(windows.find((w) => w.day === day) || { day, enabled: false, start: "09:00", end: "17:00" });
  const updateDay = (day, patch) => { const exists = windows.some((w) => w.day === day); update({ windows: exists ? windows.map((w) => w.day === day ? normalizeWindowTimes({ ...w, ...patch }) : w) : [...windows, normalizeWindowTimes({ day, enabled: true, start: "09:00", end: "17:00", ...patch })] }); };
  const save = useCallback(() => saveTimeSet({ ...draft, windows, metadata: { ...(draft.metadata || {}), view } }), [draft, windows, view, saveTimeSet]);
  useEffect(() => { registerHeaderSaveAction({ section: "time-sets", label: "Save time set", disabled: saving || !draft.name?.trim(), busy: saving, onSave: save }); return () => registerHeaderSaveAction(null); }, [draft, saving, save, registerHeaderSaveAction]);
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconCalendar} title={draft.id ? draft.name : "Time set configuration"} subtitle="Timezone-aware weekly windows"><InputBlock label="Name" value={draft.name} onChange={(v) => update({ name: v })} /><div className="mt-3"><Label>Description</Label><Textarea className="mt-2" rows={2} value={draft.description || ""} onChange={(e) => update({ description: e.target.value })} /></div><div className="mt-3 grid gap-3"><ToggleRow label="Active" checked={draft.status === "active"} onCheckedChange={(checked) => update(activeToggleStatusPatch(checked))} /><TimeZoneSelect label="Time Zone" value={draft.timezone || "Europe/Warsaw"} options={timezoneOptions} onChange={(v) => update({ timezone: v })} /><p className="text-xs text-muted-foreground">Active time sets are visible on campaign configuration.</p></div></SettingCard><div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/30 p-1"><Button type="button" variant={view === "calendar" ? "default" : "ghost"} size="sm" onClick={() => setView("calendar")}>Calendar View</Button><Button type="button" variant={view === "detail" ? "default" : "ghost"} size="sm" onClick={() => setView("detail")}>Detail View</Button></div>{view === "calendar" ? <TimeSetCalendar windows={windows} onUpdateDay={updateDay} /> : <SettingCard icon={IconListDetails} title="Detail View" subtitle="Start is inclusive; stop is exclusive"><div className="space-y-2">{WEEKDAYS.map((day) => { const row = dayWindow(day.id); return <div key={day.id} className="grid grid-cols-[40px_42px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1.5 rounded-lg border bg-background/70 p-1.5 text-xs sm:gap-2 sm:p-2"><div className="font-medium">{day.label}</div><div className="flex justify-center"><Switch checked={row.enabled !== false} onCheckedChange={(v) => updateDay(day.id, { enabled: v })} /></div><Input className="h-8 min-w-0 px-2 text-xs" type="time" value={row.start || "09:00"} onChange={(e) => updateDay(day.id, { start: e.target.value })} /><Input className="h-8 min-w-0 px-2 text-xs" type="time" value={row.end || "17:00"} onChange={(e) => updateDay(day.id, { end: e.target.value })} /></div>; })}</div></SettingCard>}</div>;
}

function TimeSetCalendar({ windows, onUpdateDay }) {
  const hours = Array.from({ length: 24 }, (_, idx) => idx);
  const scrollRef = useRef(null);
  const didSetInitialScroll = useRef(false);
  const windowFor = (day) => normalizeWindowTimes((windows || []).find((w) => w.day === day) || { day, enabled: false, start: "09:00", end: "17:00" });

  useEffect(() => {
    if (didSetInitialScroll.current || !scrollRef.current) return;
    const activeWindows = (windows || []).filter((w) => w.enabled !== false);
    const firstStart = activeWindows.length ? Math.min(...activeWindows.map((w) => timeToMinutes(w.start || "09:00", 9 * 60))) : 9 * 60;
    const targetMinute = Math.max(calendarStartMinute, firstStart - 60);
    const maxScroll = Math.max(0, scrollRef.current.scrollHeight - scrollRef.current.clientHeight);
    scrollRef.current.scrollTop = Math.min(maxScroll, (targetMinute / calendarTotalMinutes) * calendarGridHeight);
    didSetInitialScroll.current = true;
  }, [windows]);

  const startDrag = (event, day, edge) => {
    event.preventDefault();
    event.stopPropagation();
    const column = event.currentTarget.closest("[data-calendar-column]");
    if (!column) return;
    const rect = column.getBoundingClientRect();
    const apply = (clientY) => {
      const current = windowFor(day);
      const start = timeToMinutes(current.start || "09:00");
      const end = timeToEndMinutes(current.end || "17:00", start + calendarSnapMinutes);
      const raw = calendarStartMinute + ((clientY - rect.top) / rect.height) * calendarTotalMinutes;
      const snapped = Math.round(raw / calendarSnapMinutes) * calendarSnapMinutes;
      const next = Math.max(calendarStartMinute, Math.min(calendarEndMinute, snapped));
      if (edge === "start") onUpdateDay(day, { enabled: true, start: minutesToTime(Math.min(next, end - calendarSnapMinutes)) });
      else onUpdateDay(day, { enabled: true, end: minutesToTime(Math.min(calendarEndMinute, Math.max(next, start + calendarSnapMinutes))) });
    };
    const move = (moveEvent) => apply(moveEvent.clientY);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    apply(event.clientY);
  };

  return <SettingCard icon={IconCalendar} title="Calendar View" subtitle="Scroll 00:00–24:00 and drag top or bottom handles to resize; snaps to 15 minutes"><div className="overflow-hidden rounded-xl border text-[10px]"><div className="grid grid-cols-[42px_repeat(7,minmax(0,1fr))] bg-muted/50"><span className="p-2">Hour</span>{WEEKDAYS.map((d) => { const row = windowFor(d.id); const enabled = row.enabled !== false; return <span key={d.id} className={`flex flex-col items-center gap-1 border-l p-2 text-center font-semibold transition ${enabled ? "text-foreground" : "bg-muted/40 text-muted-foreground/60"}`}><Checkbox aria-label={`${enabled ? "Disable" : "Enable"} ${d.label}`} checked={enabled} onCheckedChange={(checked) => onUpdateDay(d.id, { enabled: checked === true })} className="size-4 border-emerald-500/70 bg-background shadow-sm data-[state=checked]:border-emerald-500 data-[state=checked]:!bg-emerald-500 data-[state=checked]:!text-white dark:border-emerald-400/70 dark:data-[state=checked]:border-emerald-400 dark:data-[state=checked]:!bg-emerald-500 dark:data-[state=checked]:!text-white [&_[data-slot=checkbox-indicator]]:text-white [&_[data-slot=checkbox-indicator]_svg]:size-3" /><span>{d.label}</span></span>; })}</div><div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight: `${calendarViewportHeight}px` }}><div className="grid grid-cols-[42px_repeat(7,minmax(0,1fr))]" style={{ height: `${calendarGridHeight}px` }}><div>{hours.map((hour) => <div key={hour} className="h-7 border-t p-2 text-muted-foreground">{String(hour).padStart(2, "0")}:00</div>)}</div>{WEEKDAYS.map((d) => { const row = windowFor(d.id); const enabled = row.enabled !== false; const start = timeToMinutes(row.start || "09:00"); const end = timeToEndMinutes(row.end || "17:00", start + calendarSnapMinutes); const top = ((Math.max(calendarStartMinute, Math.min(calendarEndMinute, start)) - calendarStartMinute) / calendarTotalMinutes) * 100; const bottom = ((Math.max(calendarStartMinute, Math.min(calendarEndMinute, end)) - calendarStartMinute) / calendarTotalMinutes) * 100; return <div key={d.id} data-calendar-column aria-disabled={!enabled} className={`relative border-l bg-[linear-gradient(to_bottom,hsl(var(--border))_1px,transparent_1px)] bg-[length:100%_28px] transition ${enabled ? "bg-background/60" : "bg-muted/25 opacity-60"}`} style={{ height: `${calendarGridHeight}px` }}><div className="absolute inset-x-1 rounded-md border border-dashed border-muted-foreground/20 bg-muted/20 p-1 text-center text-[9px] text-muted-foreground" style={{ top: `${top}%`, height: `${Math.max(4, bottom - top)}%`, display: enabled ? undefined : "none" }}><button type="button" aria-label={`Adjust ${d.label} start time`} onPointerDown={(event) => startDrag(event, d.id, "start")} className="absolute left-1/2 top-0 h-3 w-8 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full border border-emerald-600/50 bg-emerald-500 shadow-sm" /><div className="flex h-full min-h-5 items-center justify-center rounded bg-emerald-500/25 px-1 font-semibold text-emerald-800 dark:text-emerald-200">{row.start || "09:00"}–{row.end || "17:00"}</div><button type="button" aria-label={`Adjust ${d.label} end time`} onPointerDown={(event) => startDrag(event, d.id, "end")} className="absolute bottom-0 left-1/2 h-3 w-8 -translate-x-1/2 translate-y-1/2 cursor-ns-resize rounded-full border border-emerald-600/50 bg-emerald-500 shadow-sm" /></div></div>; })}</div></div></div></SettingCard>;
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

function DashboardMonitorPanel({ campaign, contactLists, executionDebug }) {
  const attemptsRef = useRef(null);
  if (!campaign) return <div className="flex-1 min-h-0 overflow-y-auto p-4"><Empty title="No campaign selected" description="Published campaigns appear here once they are out of draft/design status." /></div>;
  const progress = campaignContactProgress(campaign, contactLists, executionDebug);
  const debugRunner = executionDebug?.runner || { running: false, inFlight: false };
  const debugSummary = executionDebug?.summary || {};
  const recentAttempts = Array.isArray(executionDebug?.recent_attempts) ? executionDebug.recent_attempts : [];


  return <div className="flex-1 min-h-0 p-4 space-y-4"><SettingCard icon={IconActivity} title="Execution debug panel" subtitle={campaign.name}><div className="space-y-3"><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">State</span><Badge variant="outline" className={statusClass(executionStateFor(campaign))}>{title(executionStateFor(campaign))}</Badge></div><div><div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>{progress.completed.toLocaleString()} of {progress.total.toLocaleString()} records</span><span>{progress.remaining.toLocaleString()} remaining</span></div><Progress className="h-2" value={progress.progress} /></div><div className="grid grid-cols-2 gap-2 text-xs"><MiniStat label="Runner" value={debugRunner.running ? "Running" : "Stopped"} icon={IconPlayerPlay} tone={debugRunner.running ? "emerald" : "amber"} /><MiniStat label="In-flight" value={Number(debugSummary.active_now || 0).toLocaleString()} icon={IconLoader2} tone={Number(debugSummary.active_now || 0) > 0 ? "violet" : "blue"} /><MiniStat label="Attempts 15m" value={Number(debugSummary.attempts_last_15m || 0).toLocaleString()} icon={IconListDetails} tone="blue" /><MiniStat label="Dialing now" value={Number(debugSummary.dialing_now || 0).toLocaleString()} icon={IconPhoneCall} tone="violet" /></div><div className="text-[11px] text-muted-foreground">Last attempt: {debugSummary.last_attempt_at ? new Date(debugSummary.last_attempt_at).toLocaleString() : "not yet"} · 30m answered/failed/suppressed: {Number(debugSummary.answered_last_30m || 0)}/{Number(debugSummary.failed_last_30m || 0)}/{Number(debugSummary.suppressed_last_30m || 0)}</div><div className="rounded-lg border bg-muted/20 p-2"><div className="mb-2 text-xs font-medium">Latest call attempts</div><div ref={attemptsRef} className="max-h-[min(24rem,calc(100vh-34rem))] overflow-y-auto overscroll-contain space-y-2 pr-1">{recentAttempts.length ? recentAttempts.map((attempt) => { const reason = attempt.suppression_reason || attempt.failure_reason || attempt.skip_reason || attempt.reason_code || "—"; return <div key={attempt.id} className="rounded-md border bg-background px-2 py-1.5 text-xs"><div className="flex items-center justify-between gap-2"><Badge variant="outline" className={attemptStatusClass(attempt.status)}>{title(attempt.status)}</Badge><span className="text-muted-foreground">{attempt.created_at ? new Date(attempt.created_at).toLocaleTimeString() : ""}</span></div><div className="mt-1 text-muted-foreground">TO: {attempt.to_number || "—"} · FROM: {attempt.from_number || "—"}</div><div className="mt-1 text-muted-foreground">Reason: {reason}</div></div>; }) : <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">No attempts yet.</div>}</div></div></div></SettingCard></div>;
}

function MappingEditor({ campaign, forms, contactLists, update }) {
  const selectedForm = forms.find((form) => form.id === campaign.attached_form_id);
  if (!selectedForm) return null;

  const list = contactLists.find((l) => l.id === campaign.contact_list_id);
  const fields = contactListFieldOptions(list);
  const variables = formVariableOptions(selectedForm);
  const mapping = campaign.form_variable_mapping || [];
  const canAdd = Boolean(fields.length && variables.length);
  const add = () => {
    if (!canAdd) return;
    update({ form_variable_mapping: [...mapping, { source: fields[0] || "", target: variables[0]?.value || "", required: false }] });
  };
  const updateRow = (idx, patch) => update({ form_variable_mapping: mapping.map((m, i) => i === idx ? { ...m, ...patch } : m) });

  return <div className="mt-5 rounded-xl border bg-card/70 p-4 shadow-sm"><div><div className="flex items-center gap-2 font-semibold"><IconForms className="h-4 w-4 text-sky-600" />Forms variable mapping</div><p className="mt-1 text-sm text-muted-foreground">Map selected contact-list fields into variables defined in the agent script selected</p></div><div className="mt-4 overflow-hidden rounded-xl border bg-background/70 text-sm"><div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 bg-muted/60 px-3 py-2 text-xs font-semibold text-muted-foreground"><span className="min-w-0 truncate">Form variable</span><span className="min-w-0 truncate">Contact field</span></div>{mapping.length ? mapping.map((row, idx) => {
    const currentVariable = row.target || variables[0]?.value || "__no_variables__";
    const variableOptions = variables.some((item) => item.value === row.target) || !row.target ? variables : [{ value: row.target, label: `${row.target} (not in selected form)`, disabled: true }, ...variables];
    const selectTriggerClass = "h-9 w-full min-w-0 overflow-hidden [&>span]:truncate";
    return <div key={idx} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 border-t px-3 py-2"><div className="min-w-0"><Select value={currentVariable} disabled={!variables.length} onValueChange={(v) => updateRow(idx, { target: v })}><SelectTrigger className={selectTriggerClass}><SelectValue placeholder="Select form variable" /></SelectTrigger><SelectContent className="w-[--radix-select-trigger-width] max-w-[--radix-select-trigger-width]">{variableOptions.length ? variableOptions.map((variable) => <SelectItem key={variable.value} value={variable.value} disabled={Boolean(variable.disabled)}><span className="block min-w-0 max-w-full truncate">{variable.label}</span></SelectItem>) : <SelectItem value="__no_variables__" disabled>No form variables found</SelectItem>}</SelectContent></Select></div><div className="min-w-0"><Select value={row.source || fields[0] || "__no_fields__"} disabled={!fields.length} onValueChange={(v) => updateRow(idx, { source: v })}><SelectTrigger className={selectTriggerClass}><SelectValue placeholder="Select contact field" /></SelectTrigger><SelectContent className="w-[--radix-select-trigger-width] max-w-[--radix-select-trigger-width]">{fields.length ? fields.map((f) => <SelectItem key={f} value={f}><span className="block min-w-0 max-w-full truncate">{f}</span></SelectItem>) : <SelectItem value="__no_fields__" disabled>No contact-list fields found</SelectItem>}</SelectContent></Select></div></div>;
  }) : <div className="px-3 py-4 text-sm text-muted-foreground">No mappings yet. Add one after attaching a contact list with fields and an agent script with variables.</div>}</div>{!canAdd ? <div className="mt-3 rounded-lg border border-dashed bg-background/60 px-3 py-2 text-xs text-muted-foreground">{!variables.length ? "No variables were found in the selected agent script. Add data-producing fields with variable names to the form before mapping contact-list fields." : "Attach a contact list with imported or custom fields before adding mappings."}</div> : null}<div className="mt-3 flex justify-end"><Button size="sm" onClick={add} disabled={!canAdd} className={neutralActionClass}>Add mapping</Button></div></div>;
}

function outboundEventsFromCampaigns(campaigns = [], executionDebugByCampaign = {}) {
  return campaignStatusEventsFromCampaigns(campaigns, executionDebugByCampaign);
}

function paginateItems(items = [], page = 1, pageSize = 10) {
  const safeItems = Array.isArray(items) ? items : [];
  const safePageSize = [10, 25, 50].includes(Number(pageSize)) ? Number(pageSize) : 10;
  const totalPages = Math.max(1, Math.ceil(safeItems.length / safePageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * safePageSize;
  return { items: safeItems.slice(start, start + safePageSize), page: safePage, pageSize: safePageSize, totalPages, start: safeItems.length ? start + 1 : 0, end: Math.min(safeItems.length, start + safePageSize) };
}

function PaginatedListControls({ total = 0, page = 1, pageSize = 10, onPageChange = () => {}, onPageSizeChange = () => {}, label = "records" }) {
  const pagination = paginateItems(Array.from({ length: Number(total || 0) }), page, pageSize);
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/25 px-3 py-2 text-xs"><div className="text-muted-foreground">{total ? `${pagination.start}-${pagination.end} of ${Number(total).toLocaleString()} ${label}` : `0 ${label}`}</div><div className="flex flex-wrap items-center gap-2"><div className="flex items-center gap-2"><span className="text-muted-foreground">Rows</span><ConfigSelect bare value={String(pagination.pageSize)} options={[10, 25, 50].map((value) => ({ value: String(value), label: String(value) }))} onChange={(value) => onPageSizeChange(Number(value))} /></div><div className="flex items-center gap-1"><Button type="button" size="sm" variant="outline" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)}>Previous</Button><Badge variant="outline" className="bg-card">Page {pagination.page}/{pagination.totalPages}</Badge><Button type="button" size="sm" variant="outline" disabled={pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)}>Next</Button></div></div></div>;
}

function EventList({ events = [], empty }) {
  return <div className="relative space-y-0 pl-6">{events.length ? events.map((event, idx) => <div key={`${event.campaign_id}-${event.type}-${event.timestamp}-${idx}`} className="relative border-l pb-5 pl-5 last:pb-0"><span className={`absolute -left-2 top-1 flex h-4 w-4 rounded-full border-2 border-background shadow ${event.type === "exhausted" ? "bg-fuchsia-500" : event.type === "stop" ? "bg-rose-500" : event.type === "pause" ? "bg-amber-500" : event.type === "recycle" ? "bg-violet-500" : "bg-emerald-500"}`} /><div className="rounded-xl border bg-muted/30 p-3 text-sm shadow-sm"><div className="flex flex-wrap items-center justify-between gap-2"><Badge variant="outline" className={statusClass(event.type)}>{title(event.type)}</Badge><Badge variant="outline" className="font-normal">{event.campaign_name || "Campaign"}</Badge></div><div className="mt-1 text-xs text-muted-foreground">{event.timestamp ? new Date(event.timestamp).toLocaleString() : "timestamp unavailable"}</div><div className="mt-2 text-xs text-muted-foreground">{event.details}</div></div></div>) : <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{empty}</div>}</div>;
}

function PanelHeader({ title, description }) { return <div className="h-16 shrink-0 border-b px-4 flex flex-col justify-center"><h2 className="text-sm font-semibold">{title}</h2><p className="text-xs text-muted-foreground">{description}</p></div>; }
function MiniStat({ label, value, icon: Icon, tone = "blue" }) { return <div className="rounded-lg border bg-muted/40 p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 truncate text-sm font-semibold">{value}</div></div>{Icon ? <span className={`shrink-0 rounded-lg bg-gradient-to-br p-1.5 ${toneClasses[tone] || toneClasses.blue}`}><Icon className="h-3.5 w-3.5" /></span> : null}</div></div>; }
function RequiredFieldLabel({ children, required = false, className = "" }) { return <Label className={className}>{children}{required ? <span aria-hidden="true" className="ml-1 text-red-500">*</span> : null}</Label>; }
function ConfigSelect({ label, value, options = [], onChange = () => {}, bare = false, required = false }) {
  const normalized = options.map((o) => typeof o === "string" ? { value: o, label: title(o) } : o);
  const select = <Select value={value || normalized[0]?.value} onValueChange={onChange}><SelectTrigger className="w-full min-w-0"><SelectValue /></SelectTrigger><SelectContent className="w-[--radix-select-trigger-width] max-w-[--radix-select-trigger-width]">{normalized.map((o) => <SelectItem key={o.value} value={o.value} disabled={Boolean(o.disabled)}><span className="block min-w-0 max-w-full truncate">{o.label}</span></SelectItem>)}</SelectContent></Select>;
  return bare ? select : <div className="min-w-0 space-y-2"><RequiredFieldLabel required={required}>{label}</RequiredFieldLabel>{select}</div>;
}

function routingTypeBadgeClass(routingType) {
  const value = String(routingType || "").toLowerCase();
  if (value.includes("skill")) return "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  if (value.includes("round")) return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (value.includes("priority")) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

function CampaignPriorityStarRating({ label = "Priority", value = 3, onChange = () => {}, maxStars = 5 }) {
  const currentValue = Math.min(maxStars, Math.max(1, Number(value) || 3));
  return <div className="mt-3"><div className="flex items-center gap-3"><Label>{label}</Label><div className="flex items-center gap-1" aria-label={`${label}: ${currentValue} of ${maxStars} stars`}>{Array.from({ length: maxStars }, (_, index) => { const starValue = index + 1; const filled = starValue <= currentValue; return <button key={starValue} type="button" onClick={() => onChange(starValue)} className="rounded p-0.5 transition hover:scale-105 focus:outline-none focus:ring-2 focus:ring-amber-500/40" aria-label={`Set priority to ${starValue} stars`}>{filled ? <IconStarFilled className="h-5 w-5 text-amber-400" /> : <IconStar className="h-5 w-5 text-muted-foreground/40" />}</button>; })}</div></div></div>;
}

function CampaignReferenceSelect({ label, value, options = [], onChange = () => {}, required = false, kind = "queue", disabled = false }) {
  const normalized = Array.isArray(options) ? options.filter(Boolean) : [];
  const emptyLabel = disabled ? "Agent activation" : normalized.length ? "Select target" : `No ${title(kind)} targets loaded`;
  const selected = normalized.find((option) => option.id === value);
  return <div className="min-w-0 space-y-2"><RequiredFieldLabel required={required}>{label}</RequiredFieldLabel><Select value={value || "none"} onValueChange={onChange} disabled={disabled}><SelectTrigger className="w-full min-w-0"><SelectValue placeholder={emptyLabel}>{selected?.name || emptyLabel}</SelectValue></SelectTrigger><SelectContent className="w-[--radix-select-trigger-width] max-w-[--radix-select-trigger-width]"><SelectItem value="none" disabled={normalized.length > 0}><span className="block min-w-0 max-w-full truncate text-muted-foreground">{emptyLabel}</span></SelectItem>{normalized.map((ref) => <SelectItem key={ref.id} value={ref.id}><span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate">{ref.name}</span>{kind === "queue" ? <Badge variant="outline" className={`${routingTypeBadgeClass(ref.routing_type || ref.routingType)} shrink-0 text-[10px]`}>{title(ref.routing_type || ref.routingType || "fifo")}</Badge> : null}</span></SelectItem>)}</SelectContent></Select></div>;
}

function AgentScriptSelect({ label, value = "none", forms = [], workflows = [], onChange = () => {} }) {
  const [open, setOpen] = useState(false);
  const formOptions = (forms || []).map((form) => ({ value: `form:${form.id}`, label: form.name || form.title || form.id }));
  const workflowOptions = (workflows || []).map((workflow) => ({ value: `workflow:${workflow.id}`, label: workflow.name || workflow.label || workflow.id }));
  const selected = [...formOptions, ...workflowOptions].find((option) => option.value === value);
  const choose = (nextValue) => { onChange(nextValue); setOpen(false); };
  return <div className="min-w-0 space-y-2"><Label>{label}</Label><Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" variant="outline" role="combobox" className="w-full justify-between bg-background px-3 font-normal"><span className={`truncate ${selected ? "text-foreground" : "text-muted-foreground"}`}>{selected?.label || "Not attached"}</span><IconChevronDown className={`ml-2 h-4 w-4 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} /></Button></PopoverTrigger><PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0"><Command><CommandInput placeholder="Search forms or workflows..." className="h-9" /><CommandEmpty>No agent script found.</CommandEmpty><CommandGroup><CommandItem value="none" onSelect={() => choose("none")}><IconCheck className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${value === "none" ? "opacity-100" : "opacity-0"}`} /><span>Not attached</span></CommandItem></CommandGroup><CommandGroup heading="Forms">{formOptions.map((option) => <CommandItem key={option.value} value={`form ${option.label} ${option.value}`} onSelect={() => choose(option.value)}><IconCheck className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${value === option.value ? "opacity-100" : "opacity-0"}`} /><IconForms className="mr-2 h-4 w-4 text-sky-600" /><span className="truncate">{option.label}</span></CommandItem>)}</CommandGroup><CommandGroup heading="Workflows">{workflowOptions.map((option) => <CommandItem key={option.value} value={`workflow ${option.label} ${option.value}`} onSelect={() => choose(option.value)}><IconCheck className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${value === option.value ? "opacity-100" : "opacity-0"}`} /><IconWand className="mr-2 h-4 w-4 text-violet-600" /><span className="truncate">{option.label}</span></CommandItem>)}</CommandGroup></Command></PopoverContent></Popover></div>;
}

function TimeZoneSelect({ label, value, options = [], onChange = () => {} }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value) || timeZoneOptionFor(value || "Europe/Warsaw");
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? options.filter((option) => [option.value, option.label, option.offset].filter(Boolean).some((text) => String(text).toLowerCase().includes(normalizedQuery)))
    : options;
  const choose = (nextValue) => { onChange(nextValue); setOpen(false); setQuery(""); };
  return <div className="space-y-2"><Label>{label}</Label><Popover open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) setQuery(""); }}><PopoverTrigger asChild><Button type="button" variant="outline" className="h-10 w-full justify-between bg-background px-3 text-left font-normal"><span className="truncate">{selected?.label || value || "Select timezone"}</span><IconChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-60" /></Button></PopoverTrigger><PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-2"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search timezone or UTC offset…" className="h-9" autoFocus /><div className="mt-2 max-h-64 overflow-y-auto pr-1"><div className="space-y-1">{filtered.length ? filtered.map((option) => <button key={option.value} type="button" onClick={() => choose(option.value)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-muted ${option.value === value ? "bg-muted" : ""}`}><IconCheck className={`h-4 w-4 shrink-0 ${option.value === value ? "opacity-100" : "opacity-0"}`} /><span className="min-w-0 flex-1 truncate">{option.label}</span></button>) : <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No timezones match this search.</div>}</div></div></PopoverContent></Popover></div>;
}
function InputBlock({ label, value, onChange = () => {}, type = "text", min, max, required = false }) { return <div className="space-y-2"><RequiredFieldLabel required={required}>{label}</RequiredFieldLabel><Input type={type} min={min} max={max} value={value ?? ""} onChange={(e) => onChange(e.target.value)} /></div>; }
function MultiSelect({ label, values = [], options = [], onChange = () => {}, emptyLabel = "No options available", showSelectedBadges = true, required = false }) {
  const [open, setOpen] = useState(false);
  const normalized = options.map((o) => typeof o === "string" ? { value: o, label: o } : o);
  const selected = normalized.filter((o) => values.includes(o.value));
  const toggle = (value) => onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  return <div className="space-y-2">{label ? <RequiredFieldLabel required={required}>{label}</RequiredFieldLabel> : null}<Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" variant="outline" className="w-full justify-between"><span className="truncate">{selected.length ? `${selected.length} selected` : "Select values"}</span><IconChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-60" /></Button></PopoverTrigger><PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-2"><div className="max-h-64 overflow-y-auto pr-1"><div className="space-y-1">{normalized.length ? normalized.map((o) => { const checked = values.includes(o.value); return <button key={o.value} type="button" onClick={() => toggle(o.value)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-muted"><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${checked ? "border-emerald-500 bg-emerald-500 text-white shadow-sm shadow-emerald-500/20" : "border-muted-foreground/35 bg-background text-transparent dark:border-muted-foreground/45 dark:bg-background/80"}`} aria-hidden="true">{checked ? <IconCheck className="h-3.5 w-3.5 stroke-[3] text-white dark:text-white" /> : null}</span><span className="min-w-0 flex-1 truncate font-medium text-foreground">{o.label}</span></button>; }) : <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{emptyLabel}</div>}</div></div></PopoverContent></Popover>{showSelectedBadges ? (selected.length ? <div className="flex flex-wrap gap-1">{selected.map((o) => <Badge key={o.value} variant="outline" className="font-normal">{o.label}</Badge>)}</div> : <p className="text-xs text-muted-foreground">{emptyLabel}</p>) : null}</div>;
}
function contactListFieldOptions(list) {
  const metadata = list?.metadata || {};
  const importSettings = metadata.csv_import_settings || metadata.csvImportSettings || {};
  const schemaFields = (list?.custom_field_schema || []).map((f) => f?.name).filter(Boolean);
  const metadataSchemaFields = (importSettings.field_schema || importSettings.fieldSchema || []).map((f) => f?.name).filter(Boolean);
  const selectedColumns = importSettings.selected_columns || importSettings.selectedColumns || [];
  const rowDataColumns = list?.row_data_columns || list?.rowDataColumns || [];
  return [...new Set([...schemaFields, ...metadataSchemaFields, ...selectedColumns, ...rowDataColumns].map((field) => String(field || "").trim()).filter(Boolean))];
}
function formVariableOptions(form) {
  const fields = Array.isArray(form?.schema?.fields) ? form.schema.fields : [];
  return fields
    .filter((field) => FORM_DATA_FIELD_TYPES.has(field?.type) && String(field?.variableName || field?.variable_name || "").trim())
    .map((field) => {
      const value = String(field.variableName || field.variable_name || "").trim();
      const label = String(field.label || field.id || value).trim();
      return { value, label: label === value ? value : `${value} · ${label}` };
    });
}
function contactListNumberOptions(list) { const fields = (list?.custom_field_schema || []).filter((f) => (f.type === "phone") || /phone|mobile|number|whatsapp/i.test(f.name || "")).map((f) => f.name).filter(Boolean); return [...new Set(fields)].map((name) => ({ value: name, label: name })); }
function ToggleRow({ label, checked = false, disabled = false, onCheckedChange = () => {} }) { return <div className={`flex items-center justify-between gap-3 rounded-lg border bg-background/70 p-3 ${disabled ? "opacity-60" : ""}`}><Label className="text-sm font-medium">{label}</Label><Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} /></div>; }
function SchemaRow({ name, type }) { return <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 px-3 py-2"><div className="min-w-0"><div className="truncate font-mono text-xs">{name}</div><div className="text-[11px] text-muted-foreground">row_data JSONB</div></div><Badge variant="outline" className="font-mono text-[10px]">{type}</Badge></div>; }
function SettingCard({ icon: Icon, title, subtitle, children }) { return <div className="rounded-2xl border bg-background/85 p-4 shadow-sm"><div className="mb-4 flex items-start gap-3"><span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600"><Icon className="h-4 w-4" /></span><div><h3 className="text-sm font-semibold">{title}</h3><p className="text-xs text-muted-foreground">{subtitle}</p></div></div>{children}</div>; }
function ReadinessLine({ label, ok }) { return <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2"><span>{label}</span><Badge variant="outline" className={ok ? statusClass("ready") : statusClass("draft")}>{ok ? "Ready" : "Needs setup"}</Badge></div>; }
function ComingSoonView({ item }) { const Icon = item.icon; return <div className="flex min-h-[520px] items-center justify-center"><div className="max-w-md rounded-3xl border bg-background/85 p-8 text-center shadow-sm"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 to-violet-500/20 text-sky-600"><Icon className="h-7 w-7" /></div><h3 className="mt-5 text-xl font-semibold">{item.label} is staged for Phase 3</h3><p className="mt-2 text-sm text-muted-foreground">The persistent model is ready. Future work can connect this area to dialer execution, audit events, DNC ingestion, and reporting data.</p><Button className="mt-5" variant="outline">View roadmap</Button></div></div>; }
function LoadingState() { return <div className="flex min-h-[520px] items-center justify-center text-muted-foreground"><IconLoader2 className="mr-2 h-5 w-5 animate-spin" />Loading outbound workspace…</div>; }
function ErrorState({ error, onRetry }) { return <div className="flex min-h-[520px] items-center justify-center"><div className="rounded-2xl border bg-background p-6 text-center shadow-sm"><h3 className="font-semibold">Could not load outbound dialer</h3><p className="mt-2 text-sm text-muted-foreground">{error}</p><Button className="mt-4" variant="outline" onClick={onRetry}>Retry</Button></div></div>; }
function Empty({ title: t, description }) { return <div className="rounded-xl border border-dashed p-6 text-center"><h4 className="font-semibold">{t}</h4><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>; }
function readiness(c) { let score = 20; if (c.contact_list_id) score += 25; if (c.attached_form_id) score += 20; if ((c.form_variable_mapping || []).length) score += 20; if (["ready", "running", "completed"].includes(c.status)) score += 15; return Math.min(score, 100); }
