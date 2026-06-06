"use client";

import * as React from "react";
import {
  IconActivity,
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconBug,
  IconCheck,
  IconClockHour4,
  IconFileText,
  IconFilter,
  IconLoader2,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconShieldCheck,
} from "@tabler/icons-react";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { notify } from "@/components/ToastNotify";
import { LOGGING_TOPIC_GROUPS, canonicalTopicFor } from "@/lib/logger/topic-catalog.mjs";

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const LOG_FILTER_LEVELS = ["", ...LEVELS];
const ROTATION_MODES = ["daily", "startup"];
const PRESETS = [
  { id: "normal-production", label: "Normal", ttl: "", description: "Production-safe defaults" },
  { id: "debug-telnyx-stt", label: "STT debug", ttl: "30", description: "Temporary Telnyx STT tracing" },
  { id: "errors-only", label: "Errors only", ttl: "60", description: "Reduce noise during incidents" },
];
const NAV_ITEMS = [
  { id: "live", label: "Live", icon: IconActivity, description: "Log Viewer" },
  { id: "files", label: "Files", icon: IconFileText, description: "JSONL log files" },
  { id: "settings", label: "Settings", icon: IconSettings, description: "Runtime logging controls" },
];
const neutralActionClass = "bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";
const badgeTone = {
  trace: "border-zinc-500/35 text-zinc-600 dark:text-zinc-300",
  debug: "border-violet-500/40 text-violet-700 dark:text-violet-300",
  info: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  warn: "border-amber-500/45 text-amber-700 dark:text-amber-300",
  error: "border-rose-500/45 text-rose-700 dark:text-rose-300",
  fatal: "border-red-600/50 text-red-700 dark:text-red-300",
};

function title(value) {
  return String(value || "")
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatLogTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return String(value);
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function localDateTimeToIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function selectedTopics(filters) {
  if (Array.isArray(filters?.topics)) return filters.topics.filter(Boolean);
  return filters?.topic ? [filters.topic] : [];
}

function appendLogFilterParams(params, filters) {
  for (const [key, value] of Object.entries(filters)) {
    if (key === "topic") continue;
    if (key === "topics") {
      selectedTopics({ topics: value }).forEach((topic) => params.append("topics", topic));
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.length) continue;
      value.forEach((item) => params.append(key, item));
      continue;
    }
    if (!value) continue;
    params.set(key, key === "from" || key === "to" ? localDateTimeToIso(value) : value);
  }
}

function groupedTopicsForSettings(config) {
  const known = new Set();
  const groups = LOGGING_TOPIC_GROUPS.map((group) => {
    known.add(group.id);
    group.topics.forEach((topic) => known.add(topic.id));
    return {
      ...group,
      topics: group.topics.map((topic) => ({ ...topic, groupId: group.id })),
    };
  });
  const customTopics = Array.from(new Set([
    ...Object.keys(config?.topicLevels || {}),
    ...Object.keys(config?.topicEnabled || {}),
  ]))
    .map((topic) => canonicalTopicFor(topic))
    .filter((topic) => topic && !known.has(topic))
    .sort((a, b) => a.localeCompare(b))
    .map((topic) => ({ id: topic, label: title(topic), description: "Custom or historical topic discovered in runtime config.", defaultLevel: config?.globalLevel || "info", groupId: "custom" }));
  if (customTopics.length) {
    groups.push({
      id: "custom",
      label: "Custom & Legacy",
      description: "Custom or historical topics kept for backward-compatible filtering and runtime control.",
      defaultLevel: config?.globalLevel || "info",
      topics: customTopics,
    });
  }
  return groups;
}

function mutableConfigPayload(config) {
  const retentionDays = Number(config.retentionDays);
  if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("Retention days must be between 1 and 365");
  }
  const globalLevel = LEVELS.includes(config.globalLevel) ? config.globalLevel : "info";
  const rotationMode = ROTATION_MODES.includes(config.rotationMode) ? config.rotationMode : "daily";
  return {
    enabled: config.enabled === true,
    globalLevel,
    consoleEnabled: config.consoleEnabled !== false,
    consolePretty: config.consolePretty === true,
    consoleFriendly: config.consoleFriendly === true,
    fileEnabled: config.fileEnabled === true,
    rotationMode,
    retentionDays,
    topicLevels: config.topicLevels || {},
    topicEnabled: config.topicEnabled || {},
    redactionEnabled: true,
  };
}

export default function AdminLoggingPage() {
  const [active, setActive] = React.useState("live");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [config, setConfig] = React.useState(null);
  const [logsLoading, setLogsLoading] = React.useState(false);
  const [logFiles, setLogFiles] = React.useState([]);
  const [logEntries, setLogEntries] = React.useState([]);
  const [logMeta, setLogMeta] = React.useState({ skippedInvalid: 0, truncated: false });
  const [liveConnected, setLiveConnected] = React.useState(false);
  const [liveSourceFile, setLiveSourceFile] = React.useState("");
  const [logFilters, setLogFilters] = React.useState({ file: "", level: "", topics: [], runId: "", search: "", from: "", to: "", limit: "100" });
  const [newTopic, setNewTopic] = React.useState("");
  const [confirmation, setConfirmation] = React.useState(null);

  const activeMeta = NAV_ITEMS.find((item) => item.id === active) || NAV_ITEMS[0];
  const topicGroups = React.useMemo(() => groupedTopicsForSettings(config), [config]);
  const currentFile = logFiles.find((file) => file.name === logFilters.file) || logFiles[0] || null;
  const liveFile = logFiles.find((file) => file.name === liveSourceFile) || logFiles[0] || null;

  const loadConfig = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/logging/config", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Failed to load logging config");
      setConfig({ ...data.config, redactionEnabled: true });
    } catch (error) {
      notify({ title: "Load failed", description: String(error.message || error), variant: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLogs = React.useCallback(async (filterOverrides = {}) => {
    setLogsLoading(true);
    try {
      const fileParams = new URLSearchParams({ mode: "files", limit: "30" });
      const filesResponse = await fetch(`/api/admin/logging/logs?${fileParams.toString()}`, { cache: "no-store" });
      const filesData = await filesResponse.json().catch(() => ({}));
      if (!filesResponse.ok || !filesData?.ok) throw new Error(filesData?.error || "Failed to list log files");
      const nextFiles = Array.isArray(filesData.files) ? filesData.files : [];
      setLogFiles(nextFiles);

      const effectiveFilters = { ...logFilters, ...filterOverrides };
      const params = new URLSearchParams();
      if (active === "live" && !effectiveFilters.file) params.set("latest", "1");
      appendLogFilterParams(params, effectiveFilters);
      const entriesResponse = await fetch(`/api/admin/logging/logs?${params.toString()}`, { cache: "no-store" });
      const entriesData = await entriesResponse.json().catch(() => ({}));
      if (!entriesResponse.ok || !entriesData?.ok) throw new Error(entriesData?.error || "Failed to load log entries");
      setLogEntries(Array.isArray(entriesData.entries) ? entriesData.entries : []);
      setLogMeta({ skippedInvalid: entriesData.skippedInvalid || 0, truncated: entriesData.truncated === true });
    } catch (error) {
      notify({ title: "Log load failed", description: String(error.message || error), variant: "error" });
    } finally {
      setLogsLoading(false);
    }
  }, [active, logFilters]);

  React.useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  React.useEffect(() => {
    loadLogs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (active !== "live") return undefined;
    const params = new URLSearchParams({ latest: "1", limit: logFilters.limit || "100" });
    appendLogFilterParams(params, {
      level: logFilters.level,
      topics: selectedTopics(logFilters),
      runId: logFilters.runId,
      search: logFilters.search,
      from: logFilters.from,
      to: logFilters.to,
    });
    const source = new EventSource(`/api/admin/logging/stream?${params.toString()}`);
    source.onopen = () => setLiveConnected(true);
    source.addEventListener("ready", (event) => {
      setLiveConnected(true);
      try {
        const data = JSON.parse(event.data || "{}");
        setLiveSourceFile(data.file || "");
        if (Array.isArray(data.entries)) setLogEntries(data.entries);
      } catch (_) {}
    });
    source.addEventListener("log", (event) => {
      setLiveConnected(true);
      try {
        const entry = JSON.parse(event.data || "{}");
        setLogEntries((prev) => [entry, ...prev].slice(0, Number(logFilters.limit || 100)));
      } catch (_) {}
    });
    source.onerror = () => {
      setLiveConnected(source.readyState === EventSource.OPEN);
    };
    return () => {
      setLiveConnected(false);
      source.close();
    };
  }, [active, logFilters.level, logFilters.topics, logFilters.runId, logFilters.search, logFilters.from, logFilters.to, logFilters.limit]);

  React.useEffect(() => {
    if (active !== "files") return;
    loadLogs({ file: logFilters.file || currentFile?.name || "" });
  }, [active, logFilters.file, currentFile?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateLogFilter(key, value) {
    setLogFilters((prev) => ({ ...prev, [key]: value }));
  }

  function updateConfig(patch) {
    setConfig((prev) => ({ ...(prev || {}), ...patch }));
  }

  function updateTopic(topic, patch) {
    const canonicalTopic = canonicalTopicFor(topic);
    setConfig((prev) => {
      const next = { ...(prev || {}) };
      if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
        const topicEnabled = { ...(next.topicEnabled || {}) };
        if (patch.enabled === null) delete topicEnabled[canonicalTopic];
        else topicEnabled[canonicalTopic] = patch.enabled === true;
        next.topicEnabled = topicEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "level")) {
        const topicLevels = { ...(next.topicLevels || {}) };
        if (!patch.level) delete topicLevels[canonicalTopic];
        else topicLevels[canonicalTopic] = patch.level;
        next.topicLevels = topicLevels;
      }
      return next;
    });
  }

  function addTopic() {
    const topic = newTopic.trim();
    if (!topic) return;
    if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(topic)) {
      notify({ title: "Invalid topic", description: "Use letters, numbers, dots, dashes, underscores or colons. Max 80 characters.", variant: "error" });
      return;
    }
    updateTopic(canonicalTopicFor(topic), { enabled: true, level: config?.globalLevel || "info" });
    setNewTopic("");
  }

  function closeConfirmation() {
    setConfirmation(null);
  }

  function confirmAction(options) {
    setConfirmation(options);
  }

  function runConfirmedAction() {
    const action = confirmation?.action;
    setConfirmation(null);
    action?.();
  }

  async function save(options = {}) {
    if (!config) return;
    if (config.fileEnabled && options.confirmedFileLogging !== true) {
      confirmAction({
        title: "Enable JSONL file logging?",
        description: "Logs are redacted, but may still contain operational call metadata. Continue only when you want the file sink active.",
        confirmLabel: "Enable file logging",
        action: () => save({ confirmedFileLogging: true }),
      });
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/admin/logging/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: mutableConfigPayload(config) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Failed to save logging config");
      setConfig({ ...data.config, redactionEnabled: true });
      notify({ title: "Saved", description: "Logging configuration updated", variant: "success" });
    } catch (error) {
      notify({ title: "Save failed", description: String(error.message || error), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function applyPreset(preset, ttlMinutes, options = {}) {
    if (preset !== "normal-production" && options.confirmedTroubleshooting !== true) {
      const presetLabel = PRESETS.find((item) => item.id === preset)?.label || title(preset);
      confirmAction({
        title: "Apply troubleshooting preset?",
        description: `${presetLabel} may increase log volume and file retention for the preset TTL. Use it only while actively troubleshooting.`,
        confirmLabel: "Apply preset",
        action: () => applyPreset(preset, ttlMinutes, { confirmedTroubleshooting: true }),
      });
      return;
    }
    setSaving(true);
    try {
      const body = { preset };
      if (ttlMinutes) body.ttlMinutes = Number(ttlMinutes);
      const response = await fetch("/api/admin/logging/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Failed to apply preset");
      setConfig({ ...data.config, redactionEnabled: true });
      notify({ title: "Preset applied", description: data.preset || preset, variant: "success" });
    } catch (error) {
      notify({ title: "Preset failed", description: String(error.message || error), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const headerActions = (
    <>
      <Button variant="outline" size="sm" onClick={() => { loadConfig(); loadLogs(); }} disabled={loading || saving || logsLoading}>
        <IconRefresh className={`mr-2 h-4 w-4 ${loading || logsLoading ? "animate-spin" : ""}`} />Refresh
      </Button>
      <Button size="sm" className={neutralActionClass} onClick={save} disabled={loading || saving || !config}>
        {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconCheck className="mr-2 h-4 w-4" />}
        Save changes
      </Button>
    </>
  );

  return (
    <AdminPageShell>
      <AdminPageHeader title="Logging" actions={headerActions} />
      <LoggingConfirmationDialog confirmation={confirmation} onCancel={closeConfirmation} onConfirm={runConfirmedAction} saving={saving} />
      <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr) 380px` }}>
        <SectionRail items={NAV_ITEMS} activeId={active} onSelect={setActive} ariaLabel="Logging sections" />
        <section className="min-h-0 overflow-hidden rounded-2xl border bg-card/95 shadow-sm backdrop-blur flex flex-col">
          <div className="h-16 shrink-0 border-b bg-card/95 px-5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{activeMeta.label}</h2>
              <p className="text-xs text-muted-foreground">{activeMeta.description}</p>
            </div>
            {active === "live" ? <Badge variant="outline" className="bg-background/80">{liveConnected ? "Live SSE" : "Connecting"}</Badge> : null}
            {active === "files" ? <Badge variant="outline" className="bg-background/80">{logFilters.file || currentFile?.name || "Select file"}</Badge> : null}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden p-5">
            {loading && !config ? <LoadingState /> : !config ? <EmptyState title="Logging unavailable" description="Runtime logging configuration could not be loaded." /> : active === "settings" ? (
              <SettingsView config={config} topicGroups={topicGroups} updateConfig={updateConfig} updateTopic={updateTopic} newTopic={newTopic} setNewTopic={setNewTopic} addTopic={addTopic} applyPreset={applyPreset} saving={saving} />
            ) : active === "files" ? (
              <FileLogView entries={logEntries} loading={logsLoading} meta={logMeta} fileSize={currentFile?.size} files={logFiles} />
            ) : (
              <LiveLogView entries={logEntries} loading={logsLoading} meta={logMeta} connected={liveConnected} fileSize={liveFile?.size} />
            )}
          </div>
        </section>
        <aside className="min-h-0 overflow-hidden rounded-2xl border bg-card/92 shadow-sm backdrop-blur flex flex-col">
          <PanelHeader
            title={active === "settings" ? "Runtime controls" : active === "files" ? "File filters" : "Live filters"}
            description={active === "settings" ? "Sinks, presets and topic policy" : active === "files" ? "Choose a JSONL source" : "Filter the active preview"}
          />
          {active === "settings" ? <SettingsContext config={config} updateConfig={updateConfig} applyPreset={applyPreset} saving={saving} /> : <LogFiltersPanel files={logFiles} filters={logFilters} currentFile={currentFile} topicGroups={topicGroups} update={updateLogFilter} onApply={loadLogs} loading={logsLoading} />}
        </aside>
      </main>
    </AdminPageShell>
  );
}

function LoggingConfirmationDialog({ confirmation, onCancel, onConfirm, saving }) {
  return (
    <AlertDialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-600 dark:text-amber-300">
            <IconAlertTriangle className="h-5 w-5" />
          </div>
          <AlertDialogTitle>{confirmation?.title || "Confirm logging change"}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation?.description || "This logging change may affect operational visibility or log volume."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={saving} className="bg-zinc-950 text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200">
            {confirmation?.confirmLabel || "Continue"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function LoadingState() {
  return <div className="space-y-4"><Skeleton className="h-28 w-full rounded-2xl" /><Skeleton className="h-64 w-full rounded-2xl" /><Skeleton className="h-40 w-full rounded-2xl" /></div>;
}

function EmptyState({ title: emptyTitle, description }) {
  return <div className="rounded-2xl border border-dashed bg-background/70 p-8 text-center"><div className="font-semibold">{emptyTitle}</div><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>;
}

function PanelHeader({ title: panelTitle, description }) {
  return <div className="h-16 shrink-0 border-b bg-card/95 px-4 flex items-center"><div><h3 className="text-sm font-semibold">{panelTitle}</h3><p className="text-xs text-muted-foreground">{description}</p></div></div>;
}

function MiniStat({ label, value, icon: Icon, tone = "sky" }) {
  const tones = {
    sky: "from-sky-500/18 to-blue-500/5 text-sky-600 dark:text-sky-300",
    emerald: "from-emerald-500/18 to-teal-500/5 text-emerald-600 dark:text-emerald-300",
    amber: "from-amber-500/20 to-orange-500/5 text-amber-600 dark:text-amber-300",
    rose: "from-rose-500/18 to-red-500/5 text-rose-600 dark:text-rose-300",
    violet: "from-violet-500/18 to-fuchsia-500/5 text-violet-600 dark:text-violet-300",
  };
  return <div className="rounded-2xl border bg-background/80 p-4 shadow-sm"><div className="flex items-center justify-between"><span className={`rounded-xl bg-gradient-to-br p-2.5 ${tones[tone] || tones.sky}`}><Icon className="h-5 w-5" /></span></div><div className="mt-3 text-2xl font-semibold">{value}</div><div className="mt-1 text-xs text-muted-foreground">{label}</div></div>;
}

function SettingCard({ icon: Icon, title: cardTitle, subtitle, children }) {
  return <Card className="overflow-hidden rounded-2xl bg-background/85 shadow-sm"><CardContent className="p-5"><div className="mb-4 flex items-start gap-3"><span className="rounded-xl bg-gradient-to-br from-amber-500/18 to-orange-500/5 p-2.5 text-amber-600 dark:text-amber-300"><Icon className="h-5 w-5" /></span><div><h3 className="font-semibold">{cardTitle}</h3>{subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}</div></div>{children}</CardContent></Card>;
}

function ToggleRow({ label, description, checked, onCheckedChange, disabled }) {
  return <div className="rounded-xl border bg-muted/20 p-3"><div className="flex items-start justify-between gap-3"><div><Label className="text-sm font-medium">{label}</Label>{description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}</div><Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} /></div></div>;
}

function ConfigSelect({ label, value, options, onChange, disabled }) {
  return <label className="space-y-2 text-sm"><span className="font-medium">{label}</span><Select value={String(value ?? "")} onValueChange={onChange} disabled={disabled}><SelectTrigger className="w-full bg-background"><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={String(option.value)} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent></Select></label>;
}

function LevelTabs({ value, onChange, compact = false }) {
  return <div className={`grid gap-1 rounded-xl bg-muted/45 p-1 ${compact ? "grid-cols-3" : "grid-cols-6"}`}>{LEVELS.map((level) => <button key={level} type="button" onClick={() => onChange(level)} className={`rounded-lg px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition ${value === level ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{level}</button>)}</div>;
}

function effectiveTopicLevel(topicId, groupId, config) {
  const topicLevels = config.topicLevels || {};
  return topicLevels[topicId] || topicLevels[groupId] || config.globalLevel || "info";
}

function effectiveTopicEnabled(topicId, groupId, config) {
  const topicEnabled = config.topicEnabled || {};
  if (Object.prototype.hasOwnProperty.call(topicEnabled, topicId)) return topicEnabled[topicId] !== false;
  if (Object.prototype.hasOwnProperty.call(topicEnabled, groupId)) return topicEnabled[groupId] !== false;
  return true;
}

function SettingsView({ config, topicGroups, updateConfig, updateTopic, newTopic, setNewTopic, addTopic, applyPreset, saving }) {
  const topicLevels = config.topicLevels || {};
  const topicEnabled = config.topicEnabled || {};
  const [expandedGroups, setExpandedGroups] = React.useState(() => new Set(["platform", "security", "contact-center", "voice", "telnyx"]));
  const toggleExpanded = (groupId) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MiniStat label="Global level" value={String(config.globalLevel || "info").toUpperCase()} icon={IconBug} tone="sky" />
        <MiniStat label="File sink" value={config.fileEnabled ? "On" : "Off"} icon={IconFileText} tone={config.fileEnabled ? "emerald" : "amber"} />
        <MiniStat label="Console" value={config.consoleEnabled !== false ? "On" : "Off"} icon={IconActivity} tone="violet" />
        <MiniStat label="Topic groups" value={topicGroups.length} icon={IconAdjustmentsHorizontal} tone="amber" />
      </div>
      <SettingCard icon={IconShieldCheck} title="Runtime safety" subtitle="Backend-owned guardrails remain enforced">
        <div className="grid gap-3 md:grid-cols-2">
          <ToggleRow label="Logging enabled" checked={config.enabled === true} onCheckedChange={(checked) => updateConfig({ enabled: checked })} />
          <ToggleRow label="Redaction enforced" description="Secrets are always masked. The UI cannot disable this." checked disabled />
        </div>
      </SettingCard>
      <SettingCard icon={IconAdjustmentsHorizontal} title="Topic groups" subtitle="Group-level policy with child topic overrides">
        <div className="mb-4 flex gap-2">
          <Input placeholder="Add topic, e.g. telnyx.provider-api" value={newTopic} onChange={(event) => setNewTopic(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTopic(); }} />
          <Button type="button" variant="outline" onClick={addTopic}>Add topic</Button>
        </div>
        <div data-testid="logging-topic-groups-list" data-legacy-testid="logging-topic-levels-list" className="max-h-[min(52vh,620px)] space-y-3 overflow-y-auto pr-1">
          {topicGroups.map((group) => {
            const expanded = expandedGroups.has(group.id);
            const groupLevel = topicLevels[group.id] || group.defaultLevel || config.globalLevel || "info";
            const groupEnabled = topicEnabled[group.id] !== false;
            const overrideCount = group.topics.filter((topic) => Object.prototype.hasOwnProperty.call(topicLevels, topic.id) || Object.prototype.hasOwnProperty.call(topicEnabled, topic.id)).length;
            const disabledCount = group.topics.filter((topic) => !effectiveTopicEnabled(topic.id, group.id, config)).length;
            return (
              <div key={group.id} data-testid={`logging-topic-group-${group.id}`} className="rounded-2xl border bg-card/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold">{group.label}</h4>
                      <Badge variant="outline" className="font-mono text-[11px]">{group.id}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{group.description}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                      <Badge variant="outline" className="bg-background">{group.topics.length} topics</Badge>
                      <Badge variant="outline" className="bg-background">{overrideCount} overrides</Badge>
                      <Badge variant="outline" className="bg-background">{disabledCount} disabled</Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch checked={groupEnabled} onCheckedChange={(checked) => updateTopic(group.id, { enabled: checked })} disabled={saving} />
                    <Button type="button" variant="outline" size="sm" onClick={() => toggleExpanded(group.id)}>{expanded ? "Collapse" : "Expand"}</Button>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">Group level</Label>
                  <LevelTabs value={groupLevel} onChange={(level) => updateTopic(group.id, { level })} />
                </div>
                {expanded ? (
                  <div className="mt-4 space-y-2 border-t pt-4">
                    {group.topics.map((topic) => {
                      const hasLevelOverride = Object.prototype.hasOwnProperty.call(topicLevels, topic.id);
                      const hasEnabledOverride = Object.prototype.hasOwnProperty.call(topicEnabled, topic.id);
                      const enabled = effectiveTopicEnabled(topic.id, group.id, config);
                      const level = effectiveTopicLevel(topic.id, group.id, config);
                      return (
                        <div key={topic.id} className="rounded-xl border bg-background/70 p-3">
                          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-mono text-sm font-semibold">{topic.id}</div>
                              <div className="mt-0.5 text-xs text-muted-foreground">{topic.label} · {topic.description}</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={badgeTone[level] || badgeTone.info}>Effective {level}</Badge>
                              <Switch checked={enabled} onCheckedChange={(checked) => updateTopic(topic.id, { enabled: checked })} disabled={saving} />
                            </div>
                          </div>
                          <LevelTabs value={level} onChange={(nextLevel) => updateTopic(topic.id, { level: nextLevel })} />
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button type="button" variant="ghost" size="sm" disabled={!hasLevelOverride || saving} onClick={() => updateTopic(topic.id, { level: null })}>Inherit group</Button>
                            <Button type="button" variant="ghost" size="sm" disabled={!hasEnabledOverride || saving} onClick={() => updateTopic(topic.id, { enabled: null })}>Inherit enabled</Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SettingCard>
    </div>
  );
}

function SettingsContext({ config, updateConfig, applyPreset, saving }) {
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconSettings} title="Global logging" subtitle="Runtime level and sinks"><div className="space-y-4"><div><Label className="mb-2 block text-sm font-medium">Global level</Label><LevelTabs value={config.globalLevel || "info"} onChange={(level) => updateConfig({ globalLevel: level })} compact /></div><ToggleRow label="Console logging" checked={config.consoleEnabled !== false} onCheckedChange={(checked) => updateConfig({ consoleEnabled: checked })} /><ToggleRow label="Pretty console" description="Keep pino-pretty for local operator readability." checked={config.consolePretty === true} onCheckedChange={(checked) => updateConfig({ consolePretty: checked })} /><ToggleRow label="Friendly console" description="Show one-line user-friendly console messages instead of expanded JSON object fields." checked={config.consoleFriendly === true} onCheckedChange={(checked) => updateConfig({ consoleFriendly: checked })} /><ToggleRow label="JSONL file logging" checked={config.fileEnabled === true} onCheckedChange={(checked) => updateConfig({ fileEnabled: checked })} /><ConfigSelect label="Rotation" value={config.rotationMode || "daily"} options={ROTATION_MODES.map((mode) => ({ value: mode, label: title(mode) }))} onChange={(rotationMode) => updateConfig({ rotationMode })} /><label className="space-y-2 text-sm"><span className="font-medium">Retention days</span><Input type="number" min="1" max="365" value={config.retentionDays || 14} onChange={(event) => updateConfig({ retentionDays: event.target.value })} /></label></div></SettingCard><SettingCard icon={IconAlertTriangle} title="Quick presets" subtitle="Debug presets ask for confirmation"><div className="space-y-2">{PRESETS.map((preset) => <Button key={preset.id} type="button" variant="outline" className="w-full justify-start" disabled={saving} onClick={() => applyPreset(preset.id, preset.ttl)}>{preset.label}{preset.ttl ? <span className="ml-auto text-xs text-muted-foreground">{preset.ttl}m</span> : null}</Button>)}</div></SettingCard><SettingCard icon={IconShieldCheck} title="Read-only policy" subtitle="Backend-controlled values"><div className="space-y-2 text-xs text-muted-foreground"><div className="rounded-lg border bg-muted/20 p-3">Log directory/path are intentionally not editable from the browser.</div><div className="rounded-lg border bg-muted/20 p-3">Redaction is fail-closed and re-applied when reading historical log files.</div></div></SettingCard></div>;
}

function LogFiltersPanel({ files, filters, currentFile, topicGroups, update, onApply, loading }) {
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconFilter} title="Filters" subtitle="Applied to the active log preview"><div className="space-y-3"><ConfigSelect label="File" value={filters.file || "__latest__"} options={[{ value: "__latest__", label: "Latest files" }, ...files.map((file) => ({ value: file.name, label: file.name }))]} onChange={(value) => update("file", value === "__latest__" ? "" : value)} /><ConfigSelect label="Level" value={filters.level || "__all__"} options={LOG_FILTER_LEVELS.map((level) => ({ value: level || "__all__", label: level || "All levels" }))} onChange={(value) => update("level", value === "__all__" ? "" : value)} /><TopicMultiSelect label="Topic" topicGroups={topicGroups} selectedTopics={filters.topics || []} onChange={(selected) => update("topics", selected)} /><label className="space-y-2 text-sm"><span className="font-medium">Run ID</span><Input placeholder="runId" value={filters.runId} onChange={(event) => update("runId", event.target.value)} /></label><label className="space-y-2 text-sm"><span className="font-medium">Search</span><div className="relative"><IconSearch className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="message, call ID, interaction ID…" value={filters.search} onChange={(event) => update("search", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onApply(); }} /></div></label><div className="grid grid-cols-2 gap-2"><label className="space-y-2 text-sm"><span className="font-medium">From</span><Input type="datetime-local" value={filters.from} onChange={(event) => update("from", event.target.value)} /></label><label className="space-y-2 text-sm"><span className="font-medium">To</span><Input type="datetime-local" value={filters.to} onChange={(event) => update("to", event.target.value)} /></label></div><label className="space-y-2 text-sm"><span className="font-medium">Limit</span><Input type="number" min="1" max="500" value={filters.limit} onChange={(event) => update("limit", event.target.value)} /></label><Button type="button" className="w-full" onClick={() => onApply()} disabled={loading}>{loading ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Apply filters</Button></div></SettingCard>{currentFile ? <SettingCard icon={IconFileText} title="Current source" subtitle={currentFile.name}><div className="space-y-2 text-sm"><div className="flex justify-between"><span className="text-muted-foreground">Size</span><span>{formatBytes(currentFile.size)}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Modified</span><span>{formatLogTime(currentFile.mtime || currentFile.modifiedAt)}</span></div></div></SettingCard> : null}</div>;
}

function TopicMultiSelect({ label, topicGroups, selectedTopics, onChange }) {
  const selectedSet = React.useMemo(() => new Set(selectedTopics || []), [selectedTopics]);
  const summary = selectedSet.size ? `${selectedSet.size} selected` : "All topics";
  const toggleTopic = (topic) => {
    const next = new Set(selectedSet);
    if (next.has(topic)) next.delete(topic);
    else next.add(topic);
    onChange(Array.from(next));
  };
  const setGroup = (group, selected) => {
    const next = new Set(selectedSet);
    for (const topic of group.topics) {
      if (selected) next.add(topic.id);
      else next.delete(topic.id);
    }
    onChange(Array.from(next));
  };

  return (
    <div className="space-y-2 text-sm">
      <Label className="block font-medium">{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-between font-normal">
            <span>{summary}</span>
            <span className="text-xs text-muted-foreground">{selectedSet.size ? "Multi" : "Any"}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-2">
          <div className="space-y-2">
            <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => onChange([])}>
              All topics
            </Button>
            <div data-testid="logging-topic-filter-groups" className="max-h-80 space-y-3 overflow-y-auto pr-1">
              {topicGroups.map((group) => (
                <div key={group.id} data-testid={`logging-topic-filter-group-${group.id}`} className="rounded-xl border bg-background/70 p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold">{group.label}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{group.id}</div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setGroup(group, true)}>Select group</Button>
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setGroup(group, false)}>Clear group</Button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {group.topics.map((topic) => (
                      <label key={topic.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                        <Checkbox checked={selectedSet.has(topic.id)} onCheckedChange={() => toggleTopic(topic.id)} />
                        <span className="min-w-0 truncate font-mono text-xs">{topic.id}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function LiveLogView({ entries, loading, meta, connected = false, fileSize }) {
  return <LogEntriesView entries={entries} loading={loading} meta={meta} fileSize={fileSize} emptyTitle="No matching live log entries" emptyDescription="Live reads the newest JSONL file and appends matching events over SSE." connectionLabel={connected ? "SSE connected" : "SSE connecting"} />;
}

function FileLogView({ entries, loading, meta, fileSize, files }) {
  return <LogEntriesView entries={entries} loading={loading} meta={meta} fileSize={fileSize} emptyTitle="No matching file log entries" emptyDescription={files.length ? "Choose a file from the filters or adjust filters to inspect historical events." : "Enable file logging or wait for JSONL files to appear."} connectionLabel="Static file snapshot" />;
}

function LogEntriesView({ entries, loading, meta, fileSize, emptyTitle, emptyDescription, connectionLabel }) {
  return <div className="flex h-full min-h-0 flex-col gap-4">{loading ? <div className="shrink-0 rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">Refreshing log preview…</div> : null}<div className="grid shrink-0 gap-3 md:grid-cols-4"><MiniStat label="Visible entries" value={entries.length} icon={IconActivity} tone="emerald" /><MiniStat label="File Size" value={formatBytes(fileSize)} icon={IconFileText} tone="violet" /><MiniStat label="Skipped invalid" value={meta.skippedInvalid || 0} icon={IconAlertTriangle} tone="amber" /><MiniStat label={connectionLabel || "Server cap"} value={meta.truncated ? "Truncated" : "OK"} icon={IconShieldCheck} tone={meta.truncated ? "rose" : "sky"} /></div><div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">{entries.length ? entries.map((entry, index) => <LogEntryCard key={`${entry.time || entry.ts || index}-${entry.runId || ""}-${index}`} entry={entry} />) : <EmptyState title={emptyTitle} description={emptyDescription} />}</div></div>;
}

function LogEntryCard({ entry }) {
  const [expanded, setExpanded] = React.useState(false);
  const level = String(entry.level || entry.severity || "info").toLowerCase();
  const topic = entry.topic || entry.scope || "app";
  const message = entry.message || entry.msg || entry.event || "Log entry";
  const time = entry.time || entry.ts || entry.timestamp;
  const meta = Object.entries(entry).filter(([key]) => !["level", "severity", "topic", "scope", "msg", "message", "event", "time", "ts", "timestamp"].includes(key));
  const maxCompactMetaItems = 4;
  const compactMeta = meta.slice(0, maxCompactMetaItems);
  const hiddenMetaCount = Math.max(0, meta.length - compactMeta.length);
  const formatMetaValue = (value) => (typeof value === "object" ? safeJsonStringify(value).replace(/\s+/g, " ") : String(value));
  const isInteractiveTarget = (target) => target?.closest?.("button, a, input, textarea, select, [role='button']");

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={() => setExpanded((open) => !open)}
      onKeyDown={(event) => {
        if (isInteractiveTarget(event.target) && event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setExpanded((open) => !open);
        }
      }}
      className="group cursor-pointer rounded-2xl border bg-background/90 px-4 py-3 shadow-sm transition hover:border-foreground/25 hover:bg-muted/20 focus:outline-none focus:ring-2 focus:ring-ring/35"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="outline" className={badgeTone[level] || badgeTone.info}>{level.toUpperCase()}</Badge>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{topic}</span>
          <span className="line-clamp-1 min-w-0 break-all text-sm font-medium">{String(message)}</span>
        </div>
        <div className="shrink-0 text-xs text-muted-foreground">{formatLogTime(time)}</div>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 overflow-hidden">
        {compactMeta.length ? compactMeta.map(([key, value]) => (
          <Badge key={key} variant="outline" className="min-w-0 max-w-[260px] shrink bg-card font-mono text-[11px]">
            <span className="shrink-0 text-muted-foreground">{key}=</span>
            <span className="truncate">{formatMetaValue(value)}</span>
          </Badge>
        )) : <span className="text-xs text-muted-foreground">Click to view full JSON entry</span>}
        {hiddenMetaCount ? <Badge variant="outline" className="shrink-0 bg-card font-mono text-[11px]">+{hiddenMetaCount} more</Badge> : null}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{expanded ? "Click to collapse" : "Click to expand"}</span>
      </div>
      {expanded ? (
        <div className="mt-3 space-y-2 rounded-xl border bg-muted/15 p-3">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>Full JSON entry</span>
            <span>JSON</span>
          </div>
          <CodeBlock code={safeJsonStringify(entry)} language="json" maxHeight={420}>
            <span onClick={(event) => event.stopPropagation()}>
              <CodeBlockCopyButton type="button" />
            </span>
          </CodeBlock>
        </div>
      ) : null}
    </div>
  );
}

function FilesView({ files, selectedFile, onSelect, loading }) {
  return <div className="space-y-4">{loading ? <div className="rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">Refreshing file list…</div> : null}<div className="grid gap-3 md:grid-cols-3"><MiniStat label="Files discovered" value={files.length} icon={IconFileText} tone="sky" /><MiniStat label="Total size" value={formatBytes(files.reduce((sum, file) => sum + Number(file.size || 0), 0))} icon={IconActivity} tone="violet" /><MiniStat label="Newest file" value={files[0]?.name ? "Ready" : "None"} icon={IconClockHour4} tone="emerald" /></div><div className="space-y-2">{files.length ? files.map((file) => <button key={file.name} type="button" onClick={() => onSelect(file.name)} className={`w-full rounded-2xl border bg-background/90 p-4 text-left shadow-sm transition hover:border-foreground/25 hover:bg-muted/40 ${selectedFile === file.name ? "border-foreground/40 bg-muted/55" : ""}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="font-mono text-sm font-semibold">{file.name}</div><div className="mt-1 text-xs text-muted-foreground">Modified {formatLogTime(file.mtime || file.modifiedAt || file.updatedAt)}</div></div><Badge variant="outline" className="bg-card">{formatBytes(file.size)}</Badge></div></button>) : <EmptyState title="No JSONL files" description="Enable file logging or wait for the application to emit log entries." />}</div></div>;
}
