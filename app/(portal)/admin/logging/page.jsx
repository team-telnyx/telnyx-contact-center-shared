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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { notify } from "@/components/ToastNotify";

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
const DEFAULT_TOPICS = [
  "app",
  "api",
  "auth",
  "contact-center",
  "routing",
  "state-manager",
  "telnyx",
  "telnyx.stt",
  "voice-webhook",
  "flow-engine",
  "agent-assist",
  "outbound-dialer",
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

function localDateTimeToIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function topicNames(config) {
  return Array.from(new Set([
    ...DEFAULT_TOPICS,
    ...Object.keys(config?.topicLevels || {}),
    ...Object.keys(config?.topicEnabled || {}),
  ])).filter(Boolean).sort((a, b) => a.localeCompare(b));
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
  const [logFilters, setLogFilters] = React.useState({ file: "", level: "", topic: "", runId: "", search: "", from: "", to: "", limit: "100" });
  const [newTopic, setNewTopic] = React.useState("");

  const activeMeta = NAV_ITEMS.find((item) => item.id === active) || NAV_ITEMS[0];
  const topics = React.useMemo(() => topicNames(config), [config]);
  const currentFile = logFiles.find((file) => file.name === logFilters.file) || logFiles[0] || null;

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
      for (const [key, value] of Object.entries(effectiveFilters)) {
        if (!value) continue;
        params.set(key, key === "from" || key === "to" ? localDateTimeToIso(value) : value);
      }
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
  }, [logFilters]);

  React.useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  React.useEffect(() => {
    loadLogs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function updateLogFilter(key, value) {
    setLogFilters((prev) => ({ ...prev, [key]: value }));
  }

  function updateConfig(patch) {
    setConfig((prev) => ({ ...(prev || {}), ...patch }));
  }

  function updateTopic(topic, patch) {
    setConfig((prev) => {
      const next = { ...(prev || {}) };
      if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
        next.topicEnabled = { ...(next.topicEnabled || {}), [topic]: patch.enabled === true };
      }
      if (patch.level) {
        next.topicLevels = { ...(next.topicLevels || {}), [topic]: patch.level };
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
    updateTopic(topic, { enabled: true, level: config?.globalLevel || "info" });
    setNewTopic("");
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    try {
      if (config.fileEnabled && !window.confirm("Enable JSONL file logging? Logs are redacted, but may still contain operational call metadata. Continue?")) {
        return;
      }
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

  async function applyPreset(preset, ttlMinutes) {
    setSaving(true);
    try {
      if (preset !== "normal-production" && !window.confirm("Apply a troubleshooting logging preset? This may increase log volume and file retention for the preset TTL.")) {
        return;
      }
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
      <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr) 380px` }}>
        <SectionRail items={NAV_ITEMS} activeId={active} onSelect={setActive} ariaLabel="Logging sections" />
        <section className="min-h-0 overflow-hidden rounded-2xl border bg-card/95 shadow-sm backdrop-blur flex flex-col">
          <div className="h-16 shrink-0 border-b bg-card/95 px-5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{activeMeta.label}</h2>
              <p className="text-xs text-muted-foreground">{activeMeta.description}</p>
            </div>
            {active === "live" ? <Badge variant="outline" className="bg-background/80">{logEntries.length} entries</Badge> : null}
            {active === "files" ? <Badge variant="outline" className="bg-background/80">{logFiles.length} files</Badge> : null}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-5">
            {loading && !config ? <LoadingState /> : !config ? <EmptyState title="Logging unavailable" description="Runtime logging configuration could not be loaded." /> : active === "settings" ? (
              <SettingsView config={config} topics={topics} updateConfig={updateConfig} updateTopic={updateTopic} newTopic={newTopic} setNewTopic={setNewTopic} addTopic={addTopic} applyPreset={applyPreset} saving={saving} />
            ) : active === "files" ? (
              <FilesView files={logFiles} selectedFile={logFilters.file} onSelect={(file) => { updateLogFilter("file", file); setActive("live"); loadLogs({ file }); }} loading={logsLoading} />
            ) : (
              <LiveLogView entries={logEntries} loading={logsLoading} meta={logMeta} />
            )}
          </div>
        </section>
        <aside className="min-h-0 overflow-hidden rounded-2xl border bg-card/92 shadow-sm backdrop-blur flex flex-col">
          <PanelHeader
            title={active === "settings" ? "Runtime controls" : active === "files" ? "File filters" : "Live filters"}
            description={active === "settings" ? "Sinks, presets and topic policy" : active === "files" ? "Choose a JSONL source" : "Filter the active preview"}
          />
          {active === "settings" ? <SettingsContext config={config} updateConfig={updateConfig} applyPreset={applyPreset} saving={saving} /> : <LogFiltersPanel files={logFiles} filters={logFilters} currentFile={currentFile} update={updateLogFilter} onApply={loadLogs} loading={logsLoading} />}
        </aside>
      </main>
    </AdminPageShell>
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

function SettingsView({ config, topics, updateConfig, updateTopic, newTopic, setNewTopic, addTopic, applyPreset, saving }) {
  const topicLevels = config.topicLevels || {};
  const topicEnabled = config.topicEnabled || {};
  return <div className="space-y-5"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><MiniStat label="Global level" value={String(config.globalLevel || "info").toUpperCase()} icon={IconBug} tone="sky" /><MiniStat label="File sink" value={config.fileEnabled ? "On" : "Off"} icon={IconFileText} tone={config.fileEnabled ? "emerald" : "amber"} /><MiniStat label="Console" value={config.consoleEnabled !== false ? "On" : "Off"} icon={IconActivity} tone="violet" /><MiniStat label="Retention" value={`${config.retentionDays || 14}d`} icon={IconClockHour4} tone="amber" /></div><SettingCard icon={IconShieldCheck} title="Runtime safety" subtitle="Backend-owned guardrails remain enforced"><div className="grid gap-3 md:grid-cols-2"><ToggleRow label="Logging enabled" checked={config.enabled === true} onCheckedChange={(checked) => updateConfig({ enabled: checked })} /><ToggleRow label="Redaction enforced" description="Secrets are always masked. The UI cannot disable this." checked disabled /></div></SettingCard><SettingCard icon={IconAdjustmentsHorizontal} title="Topic levels" subtitle="Use toggles and level tabs instead of JSON configuration"><div className="mb-4 flex gap-2"><Input placeholder="Add topic, e.g. telnyx.media" value={newTopic} onChange={(event) => setNewTopic(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTopic(); }} /><Button type="button" variant="outline" onClick={addTopic}>Add topic</Button></div><div className="space-y-3">{topics.map((topic) => { const enabled = topicEnabled[topic] !== false; const level = topicLevels[topic] || config.globalLevel || "info"; return <div key={topic} className="rounded-2xl border bg-card/70 p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><div className="font-mono text-sm font-semibold">{topic}</div><div className="mt-1 text-xs text-muted-foreground">{enabled ? "Enabled" : "Muted"} · effective level {level}</div></div><Switch checked={enabled} onCheckedChange={(checked) => updateTopic(topic, { enabled: checked })} /></div><LevelTabs value={level} onChange={(nextLevel) => updateTopic(topic, { level: nextLevel })} /></div>; })}</div></SettingCard><SettingCard icon={IconAlertTriangle} title="Troubleshooting presets" subtitle="Use TTL presets for noisy debug modes"><div className="grid gap-3 md:grid-cols-3">{PRESETS.map((preset) => <button key={preset.id} type="button" disabled={saving} onClick={() => applyPreset(preset.id, preset.ttl)} className="rounded-2xl border bg-card p-4 text-left transition hover:border-foreground/25 hover:bg-muted/50"><div className="font-semibold">{preset.label}</div><div className="mt-1 text-xs text-muted-foreground">{preset.description}</div>{preset.ttl ? <Badge variant="outline" className="mt-3 bg-background">TTL {preset.ttl}m</Badge> : <Badge variant="outline" className="mt-3 bg-background">safe default</Badge>}</button>)}</div></SettingCard></div>;
}

function SettingsContext({ config, updateConfig, applyPreset, saving }) {
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><SettingCard icon={IconSettings} title="Global logging" subtitle="Runtime level and sinks"><div className="space-y-4"><div><Label className="mb-2 block text-sm font-medium">Global level</Label><LevelTabs value={config.globalLevel || "info"} onChange={(level) => updateConfig({ globalLevel: level })} compact /></div><ToggleRow label="Console logging" checked={config.consoleEnabled !== false} onCheckedChange={(checked) => updateConfig({ consoleEnabled: checked })} /><ToggleRow label="Pretty console" description="Keep pino-pretty for local operator readability." checked={config.consolePretty === true} onCheckedChange={(checked) => updateConfig({ consolePretty: checked })} /><ToggleRow label="JSONL file logging" checked={config.fileEnabled === true} onCheckedChange={(checked) => updateConfig({ fileEnabled: checked })} /><ConfigSelect label="Rotation" value={config.rotationMode || "daily"} options={ROTATION_MODES.map((mode) => ({ value: mode, label: title(mode) }))} onChange={(rotationMode) => updateConfig({ rotationMode })} /><label className="space-y-2 text-sm"><span className="font-medium">Retention days</span><Input type="number" min="1" max="365" value={config.retentionDays || 14} onChange={(event) => updateConfig({ retentionDays: event.target.value })} /></label></div></SettingCard><SettingCard icon={IconAlertTriangle} title="Quick presets" subtitle="Debug presets ask for confirmation"><div className="space-y-2">{PRESETS.map((preset) => <Button key={preset.id} type="button" variant="outline" className="w-full justify-start" disabled={saving} onClick={() => applyPreset(preset.id, preset.ttl)}>{preset.label}{preset.ttl ? <span className="ml-auto text-xs text-muted-foreground">{preset.ttl}m</span> : null}</Button>)}</div></SettingCard><SettingCard icon={IconShieldCheck} title="Read-only policy" subtitle="Backend-controlled values"><div className="space-y-2 text-xs text-muted-foreground"><div className="rounded-lg border bg-muted/20 p-3">Log directory/path are intentionally not editable from the browser.</div><div className="rounded-lg border bg-muted/20 p-3">Redaction is fail-closed and re-applied when reading historical log files.</div></div></SettingCard></div>;
}

function LogFiltersPanel({ files, filters, currentFile, update, onApply, loading }) {
  return <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"><div className="grid grid-cols-2 gap-2"><MiniStat label="Known files" value={files.length} icon={IconFileText} tone="sky" /><MiniStat label="Current size" value={formatBytes(currentFile?.size)} icon={IconActivity} tone="violet" /></div><SettingCard icon={IconFilter} title="Filters" subtitle="Applied to the active log preview"><div className="space-y-3"><ConfigSelect label="File" value={filters.file || "__latest__"} options={[{ value: "__latest__", label: "Latest files" }, ...files.map((file) => ({ value: file.name, label: file.name }))]} onChange={(value) => update("file", value === "__latest__" ? "" : value)} /><ConfigSelect label="Level" value={filters.level || "__all__"} options={LOG_FILTER_LEVELS.map((level) => ({ value: level || "__all__", label: level || "All levels" }))} onChange={(value) => update("level", value === "__all__" ? "" : value)} /><label className="space-y-2 text-sm"><span className="font-medium">Topic</span><Input placeholder="telnyx.stt" value={filters.topic} onChange={(event) => update("topic", event.target.value)} /></label><label className="space-y-2 text-sm"><span className="font-medium">Run ID</span><Input placeholder="runId" value={filters.runId} onChange={(event) => update("runId", event.target.value)} /></label><label className="space-y-2 text-sm"><span className="font-medium">Search</span><div className="relative"><IconSearch className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="message, call ID, interaction ID…" value={filters.search} onChange={(event) => update("search", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onApply(); }} /></div></label><div className="grid grid-cols-2 gap-2"><label className="space-y-2 text-sm"><span className="font-medium">From</span><Input type="datetime-local" value={filters.from} onChange={(event) => update("from", event.target.value)} /></label><label className="space-y-2 text-sm"><span className="font-medium">To</span><Input type="datetime-local" value={filters.to} onChange={(event) => update("to", event.target.value)} /></label></div><label className="space-y-2 text-sm"><span className="font-medium">Limit</span><Input type="number" min="1" max="500" value={filters.limit} onChange={(event) => update("limit", event.target.value)} /></label><Button className={`w-full ${neutralActionClass}`} onClick={onApply} disabled={loading}>{loading ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconFilter className="mr-2 h-4 w-4" />}Apply filters</Button></div></SettingCard></div>;
}

function LiveLogView({ entries, loading, meta }) {
  return <div className="space-y-4">{loading ? <div className="rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">Refreshing log preview…</div> : null}<div className="grid gap-3 md:grid-cols-3"><MiniStat label="Visible entries" value={entries.length} icon={IconActivity} tone="emerald" /><MiniStat label="Skipped invalid" value={meta.skippedInvalid || 0} icon={IconAlertTriangle} tone="amber" /><MiniStat label="Server cap" value={meta.truncated ? "Truncated" : "OK"} icon={IconShieldCheck} tone={meta.truncated ? "rose" : "sky"} /></div><div className="space-y-2">{entries.length ? entries.map((entry, index) => <LogEntryCard key={`${entry.time || entry.ts || index}-${index}`} entry={entry} />) : <EmptyState title="No matching log entries" description="Adjust filters or enable JSONL logging to populate the live preview." />}</div></div>;
}

function LogEntryCard({ entry }) {
  const level = String(entry.level || entry.severity || "info").toLowerCase();
  const topic = entry.topic || entry.scope || "app";
  const message = entry.msg || entry.message || entry.event || "Log entry";
  const time = entry.time || entry.ts || entry.timestamp;
  const meta = Object.entries(entry).filter(([key]) => !["level", "severity", "topic", "scope", "msg", "message", "event", "time", "ts", "timestamp"].includes(key));
  return <div className="rounded-2xl border bg-background/90 p-4 shadow-sm transition hover:border-foreground/25"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className={badgeTone[level] || badgeTone.info}>{level.toUpperCase()}</Badge><span className="font-mono text-xs text-muted-foreground">{topic}</span></div><div className="mt-2 break-words text-sm font-medium">{String(message)}</div></div><div className="shrink-0 text-xs text-muted-foreground">{formatLogTime(time)}</div></div>{meta.length ? <div className="mt-3 flex flex-wrap gap-1.5">{meta.map(([key, value]) => <Badge key={key} variant="outline" className="max-w-full bg-card font-mono text-[11px]"><span className="text-muted-foreground">{key}=</span><span className="truncate">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span></Badge>)}</div> : null}<details className="mt-3 rounded-xl border bg-muted/20 px-3 py-2"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">Full JSON entry</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{JSON.stringify(entry, null, 2)}</pre></details></div>;
}

function FilesView({ files, selectedFile, onSelect, loading }) {
  return <div className="space-y-4">{loading ? <div className="rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">Refreshing file list…</div> : null}<div className="grid gap-3 md:grid-cols-3"><MiniStat label="Files discovered" value={files.length} icon={IconFileText} tone="sky" /><MiniStat label="Total size" value={formatBytes(files.reduce((sum, file) => sum + Number(file.size || 0), 0))} icon={IconActivity} tone="violet" /><MiniStat label="Newest file" value={files[0]?.name ? "Ready" : "None"} icon={IconClockHour4} tone="emerald" /></div><div className="space-y-2">{files.length ? files.map((file) => <button key={file.name} type="button" onClick={() => onSelect(file.name)} className={`w-full rounded-2xl border bg-background/90 p-4 text-left shadow-sm transition hover:border-foreground/25 hover:bg-muted/40 ${selectedFile === file.name ? "border-foreground/40 bg-muted/55" : ""}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="font-mono text-sm font-semibold">{file.name}</div><div className="mt-1 text-xs text-muted-foreground">Modified {formatLogTime(file.mtime || file.modifiedAt || file.updatedAt)}</div></div><Badge variant="outline" className="bg-card">{formatBytes(file.size)}</Badge></div></button>) : <EmptyState title="No JSONL files" description="Enable file logging or wait for the application to emit log entries." />}</div></div>;
}
