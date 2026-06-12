"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ToastNotify";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import CallGeneratorDashboardView from "@/components/contact-center/CallGeneratorDashboardView";
import {
  IconActivity,
  IconArrowDown,
  IconArrowUp,
  IconChartBar,
  IconCheck,
  IconChevronDown,
  IconClockHour4,
  IconDashboard,
  IconDeviceFloppy,
  IconList,
  IconListDetails,
  IconLoader2,
  IconMusic,
  IconPhoneCall,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconShieldCheck,
  IconSpeakerphone,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";

const API = "/api/admin/call-generator";
const WORKFLOW_TESTING_ACTION_ID = "00000000-0000-4000-8000-000000000001";

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconDashboard, description: "Live runs and generated calls" },
  { id: "scenarios", label: "Scenarios", icon: IconList, description: "Test scenarios with flow targets" },
  { id: "actions", label: "Actions", icon: IconListDetails, description: "Action sequences for generated calls" },
  { id: "settings", label: "Settings", icon: IconSettings, description: "Caps, numbers, safety rails" },
];

const SECTION_STORAGE_KEY = "admin.call-generator.activeSection";

const DEFAULT_SETTINGS = {
  enabled: false,
  max_concurrent_calls: 10,
  max_cps: 2,
  from_numbers: [],
  dial_timeout_secs: 30,
  max_call_duration_secs: 120,
  pstn_whitelist: [],
};

const emptyTarget = () => ({ flow_id: "", total_calls: 5, from_numbers: [], action_id: "", action_trigger: "call_answer", workflow_testing: false, workflow_id: "", workflow_name: "", transcription_active: false });
const emptyScenarioDraft = () => ({
  name: "",
  description: "",
  targets: [emptyTarget()],
  assert_queue: "",
  assert_answer_within: "",
  assert_max_abandon: "",
  assert_min_answer: "",
});

// Build config.assertions from editor fields (routed_to_queue,
// answer_within_secs, max_abandon_rate, min_answer_rate).
function assertionsFromDraft(draft) {
  const assertions = [];
  if (String(draft.assert_queue || "").trim()) assertions.push({ type: "routed_to_queue", queue: draft.assert_queue.trim() });
  if (Number(draft.assert_answer_within) > 0) assertions.push({ type: "answer_within_secs", seconds: Number(draft.assert_answer_within) });
  if (draft.assert_max_abandon !== "" && Number(draft.assert_max_abandon) >= 0) assertions.push({ type: "max_abandon_rate", percent: Number(draft.assert_max_abandon) });
  if (draft.assert_min_answer !== "" && Number(draft.assert_min_answer) >= 0) assertions.push({ type: "min_answer_rate", percent: Number(draft.assert_min_answer) });
  return assertions;
}

function draftAssertionFields(config) {
  const assertions = Array.isArray(config?.assertions) ? config.assertions : [];
  const find = (type) => assertions.find((a) => a?.type === type);
  return {
    assert_queue: find("routed_to_queue")?.queue || "",
    assert_answer_within: find("answer_within_secs")?.seconds ?? "",
    assert_max_abandon: find("max_abandon_rate")?.percent ?? "",
    assert_min_answer: find("min_answer_rate")?.percent ?? "",
  };
}

const emptyActionDraft = () => ({ name: "", description: "", steps: [] });

const neutralActionClass = "bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";

function PanelHeader({ title, description }) {
  return (
    <div className="h-16 shrink-0 border-b px-4 flex flex-col justify-center">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function SettingCard({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="rounded-2xl border bg-background/85 p-4 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

const toneClasses = { emerald: "from-emerald-500/18 to-teal-500/5 text-emerald-600 dark:text-emerald-300", blue: "from-sky-500/18 to-blue-500/5 text-sky-600 dark:text-sky-300", violet: "from-violet-500/18 to-fuchsia-500/5 text-violet-600 dark:text-violet-300", amber: "from-amber-500/20 to-orange-500/5 text-amber-600 dark:text-amber-300", rose: "from-rose-500/18 to-red-500/5 text-rose-600 dark:text-rose-300" };
const telnyxNumberBadgeClass = "bg-transparent text-[#00E58F] border-[#00E58F]";

function MiniStat({ label, value, icon: Icon, tone = "blue" }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-1 truncate text-sm font-semibold">{value}</div>
        </div>
        {Icon ? (
          <span className={`shrink-0 rounded-lg bg-gradient-to-br p-1.5 ${toneClasses[tone] || toneClasses.blue}`}>
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Empty({ title, description }) {
  return (
    <div className="rounded-xl border border-dashed p-6 text-center">
      <h4 className="font-semibold">{title}</h4>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function MultiSelect({ label, values = [], options = [], onChange = () => {}, emptyLabel = "No options available", showBadges = true }) {
  const [open, setOpen] = useState(false);
  const normalized = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const selected = normalized.filter((o) => values.includes(o.value));
  const toggle = (value) => onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  return (
    <div className="space-y-2">
      {label ? <Label>{label}</Label> : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-between">
            <span className="truncate">{selected.length ? `${selected.length} selected` : "Select values"}</span>
            <IconChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-2">
          <div className="max-h-64 overflow-y-auto pr-1">
            <div className="space-y-1">
              {normalized.length ? normalized.map((o) => {
                const checked = values.includes(o.value);
                return (
                  <button key={o.value} type="button" onClick={() => toggle(o.value)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-muted">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${checked ? "border-emerald-500 bg-emerald-500 text-white shadow-sm shadow-emerald-500/20" : "border-muted-foreground/35 bg-background text-transparent"}`} aria-hidden="true">
                      {checked ? <IconCheck className="h-3.5 w-3.5 stroke-[3] text-white" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{o.label}</span>
                  </button>
                );
              }) : (
                <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{emptyLabel}</div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {showBadges ? (
        selected.length ? (
          <div className="flex flex-wrap gap-1">
            {selected.map((o) => <Badge key={o.value} variant="outline" className="font-normal">{o.label}</Badge>)}
          </div>
        ) : <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : null}
    </div>
  );
}

// Shared preview-audio controller: only one preview plays at a time per
// component instance; returns play/stop helpers and the playing flag.
function useAudioPreview() {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  const stop = useCallback(() => {
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch {}
      audioRef.current = null;
    }
    setPlaying(false);
  }, []);

  useEffect(() => stop, [stop]);

  const playUrl = useCallback((url, { revoke = false } = {}) => {
    stop();
    const audio = new Audio(url);
    audioRef.current = audio;
    const done = () => {
      if (revoke) URL.revokeObjectURL(url);
      if (audioRef.current === audio) audioRef.current = null;
      setPlaying(false);
    };
    audio.onended = done;
    audio.onerror = () => {
      done();
      notify({ title: "Playback error", description: "Could not play the audio preview.", variant: "error" });
    };
    setPlaying(true);
    audio.play().catch(() => done());
  }, [stop]);

  return { playing, playUrl, stop, setPlaying };
}

// Small square play/stop button — same affordance as the Speak Text node
// and the queue position-in-queue message preview.
function PreviewButton({ playing, busy, onClick, title: buttonTitle = "Play preview" }) {
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      className="h-9 w-9 shrink-0"
      title={playing ? "Stop preview" : buttonTitle}
      onClick={onClick}
      disabled={busy}
      data-testid="cg-preview-button"
    >
      {busy ? <IconLoader2 className="h-4 w-4 animate-spin" /> : playing ? <IconPlayerStop className="h-4 w-4" /> : <IconPlayerPlay className="h-4 w-4" />}
    </Button>
  );
}

// Compact TTS voice selector following the Speak node concept:
// provider → model → voice from /api/tts/voices. The voice dropdown sits on
// its own row (so long voice names never overflow the card) with a square
// preview Play button on the right that speaks `previewText` via
// /api/tts/speech — same pattern as the call flow Speak Text node.
function VoiceSelector({ value, onChange, previewText = "" }) {
  const [providers, setProviders] = useState([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const { playing, playUrl, stop } = useAudioPreview();
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tts/voices", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { providers: [] }))
      .then((data) => { if (!cancelled) setProviders(Array.isArray(data?.providers) ? data.providers : []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setVoicesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const current = String(value || "AWS.Polly.Joanna");
  const providerId = current.split(".")[0] || "";
  const provider = providers.find((p) => p.id === providerId || p.name === providerId) || null;
  const models = provider?.models || [];
  const model = models.find((m) => current.startsWith(`${providerId}.${m.id}.`)) || models[0] || null;
  const voices = model?.voices || [];

  const preview = async () => {
    if (playing) { stop(); return; }
    const text = String(previewText || "").trim();
    if (!text) {
      notify({ title: "Nothing to preview", description: "Enter text to speak first.", variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/tts/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache, no-store, must-revalidate" },
        cache: "no-store",
        body: JSON.stringify({ text, voice: current }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const firstError = Array.isArray(errorData?.errors) ? errorData.errors[0] : null;
        throw new Error(errorData?.error || firstError?.detail || firstError?.title || "Failed to generate speech");
      }
      const audioBlob = await response.blob();
      playUrl(URL.createObjectURL(audioBlob), { revoke: true });
    } catch (error) {
      notify({ title: "Preview failed", description: error.message || "Failed to generate speech", variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Select value={voicesLoading ? "" : (provider?.id || "")} disabled={voicesLoading} onValueChange={(pid) => {
          const nextProvider = providers.find((p) => p.id === pid);
          const firstVoice = nextProvider?.models?.[0]?.voices?.[0];
          onChange(firstVoice?.id || `${pid}.`);
        }}>
          <SelectTrigger className="w-full min-w-0"><SelectValue placeholder={voicesLoading ? "Loading…" : "Provider"} /></SelectTrigger>
          <SelectContent>
            {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name || p.id}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={voicesLoading ? "" : (model?.id || "")} disabled={voicesLoading} onValueChange={(mid) => {
          const nextModel = models.find((m) => m.id === mid);
          const firstVoice = nextModel?.voices?.[0];
          onChange(firstVoice?.id || `${providerId}.${mid}.`);
        }}>
          <SelectTrigger className="w-full min-w-0"><SelectValue placeholder={voicesLoading ? "Loading…" : "Model"} /></SelectTrigger>
          <SelectContent>
            {models.map((m) => <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* While voices load, render an empty disabled select with a
              placeholder — binding `current` too early would surface the raw
              voice ID via the fallback item and stretch the trigger beyond
              the card. */}
          <Select value={voicesLoading ? "" : current} disabled={voicesLoading} onValueChange={onChange}>
            <SelectTrigger className="w-full min-w-0"><SelectValue placeholder={voicesLoading ? "Loading voices…" : "Voice"} /></SelectTrigger>
            <SelectContent>
              {voices.map((v) => <SelectItem key={v.id} value={v.id}>{v.name || v.id}</SelectItem>)}
              {!voicesLoading && !voices.length && current ? <SelectItem value={current}>{current}</SelectItem> : null}
            </SelectContent>
          </Select>
        </div>
        <PreviewButton playing={playing} busy={busy} onClick={preview} title="Play text with selected voice" />
      </div>
    </div>
  );
}

// Media Library file picker with an inline square Play button streaming the
// file through /api/admin/media-library/[mediaName]/stream.
function MediaFileSelector({ value, onChange, media = [] }) {
  const { playing, playUrl, stop } = useAudioPreview();

  const preview = () => {
    if (playing) { stop(); return; }
    if (!value) {
      notify({ title: "Nothing to preview", description: "Select a media file first.", variant: "error" });
      return;
    }
    playUrl(`/api/admin/media-library/${encodeURIComponent(value)}/stream`);
  };

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <Select value={value || ""} onValueChange={onChange}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Select from Media Library" /></SelectTrigger>
          <SelectContent>
            {media.map((m) => <SelectItem key={m.media_name} value={m.media_name}>{m.media_name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <PreviewButton playing={playing} onClick={preview} title="Play media file" />
    </div>
  );
}

function scenarioTargetsValid(targets, allowedFromNumbers) {
  if (!Array.isArray(targets) || !targets.length) return false;
  return targets.every((t) => {
    const baseValid =
      String(t.flow_id || "").trim() &&
      Number(t.total_calls) >= 1 &&
      Array.isArray(t.from_numbers) && t.from_numbers.length >= 1 &&
      t.from_numbers.every((n) => allowedFromNumbers.includes(n));
    if (!baseValid) return false;
    if (t.workflow_testing === true) return Boolean(t.workflow_id && t.transcription_active === true);
    return String(t.action_id || "").trim();
  });
}

function flowWorkflowTestingInfo(flows, flowId) {
  const flow = (Array.isArray(flows) ? flows : []).find((f) => String(f.id) === String(flowId));
  return flow?.workflow_testing || { capable: false, enabled: false, agent_assist_active: false, transcription_active: false, workflow_id: null, workflow_name: null };
}

export default function AdminCallGeneratorPage() {
  const [active, setActive] = useState("dashboard");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [scenarios, setScenarios] = useState([]);
  const [actions, setActions] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [inventoryNumbers, setInventoryNumbers] = useState([]);
  const [resources, setResources] = useState({ flows: [], media: [] });

  const [selectedScenarioId, setSelectedScenarioId] = useState(null);
  const [selectedActionId, setSelectedActionId] = useState(null);
  const [scenarioDraft, setScenarioDraft] = useState(emptyScenarioDraft());
  const [actionDraft, setActionDraft] = useState(emptyActionDraft());
  const [settingsDraft, setSettingsDraft] = useState(DEFAULT_SETTINGS);

  const activeMeta = useMemo(() => NAV_ITEMS.find((i) => i.id === active) || NAV_ITEMS[0], [active]);
  const allowedFromNumbers = Array.isArray(settings.from_numbers) ? settings.from_numbers : [];

  useEffect(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get("section");
      if (requested && NAV_ITEMS.some((i) => i.id === requested)) { setActive(requested); return; }
      const saved = localStorage.getItem(SECTION_STORAGE_KEY);
      if (saved && NAV_ITEMS.some((i) => i.id === saved)) setActive(saved);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, active);
      const url = new URL(window.location.href);
      if (url.searchParams.get("section") !== active) {
        url.searchParams.set("section", active);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {}
  }, [active]);

  const refresh = useCallback(async (toast = false) => {
    setLoading(true);
    try {
      const [scenarioRes, actionsRes, settingsRes, resourcesRes] = await Promise.all([
        fetch(`${API}/scenarios`),
        fetch(`${API}/actions`),
        fetch(`${API}/settings`),
        fetch(`${API}/resources`),
      ]);
      const scenarioData = scenarioRes.ok ? await scenarioRes.json() : { scenarios: [] };
      const actionsData = actionsRes.ok ? await actionsRes.json() : { actions: [] };
      const settingsData = settingsRes.ok ? await settingsRes.json() : { settings: DEFAULT_SETTINGS, inventoryNumbers: [] };
      const resourcesData = resourcesRes.ok ? await resourcesRes.json() : { flows: [], media: [] };
      setScenarios(scenarioData.scenarios || []);
      setActions(actionsData.actions || []);
      setSettings({ ...DEFAULT_SETTINGS, ...(settingsData.settings || {}) });
      setSettingsDraft({ ...DEFAULT_SETTINGS, ...(settingsData.settings || {}) });
      setInventoryNumbers(settingsData.inventoryNumbers || []);
      setResources({ flows: resourcesData.flows || [], media: resourcesData.media || [] });
      setRefreshNonce((n) => n + 1);
      if (toast) notify({ title: "Call generator refreshed", description: "Data reloaded.", variant: "success" });
    } catch (err) {
      notify({ title: "Failed to load call generator", description: err.message, variant: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const selectedScenario = useMemo(() => scenarios.find((s) => s.id === selectedScenarioId) || null, [scenarios, selectedScenarioId]);
  const selectedAction = useMemo(() => actions.find((a) => a.id === selectedActionId) || null, [actions, selectedActionId]);

  useEffect(() => {
    if (selectedScenario) {
      const targets = Array.isArray(selectedScenario.config?.targets) && selectedScenario.config.targets.length
        ? selectedScenario.config.targets.map((t) => ({ flow_id: t.flow_id || "", total_calls: t.total_calls || 1, from_numbers: t.from_numbers || [], action_id: t.action_id || "", action_trigger: t.action_trigger === "agent_bridge" ? "agent_bridge" : "call_answer", workflow_testing: t.workflow_testing === true, workflow_id: t.workflow_id || "", workflow_name: t.workflow_name || "", transcription_active: t.transcription_active === true }))
        : [emptyTarget()];
      setScenarioDraft({
        name: selectedScenario.name || "",
        description: selectedScenario.description || "",
        targets,
        ...draftAssertionFields(selectedScenario.config),
      });
    } else {
      setScenarioDraft(emptyScenarioDraft());
    }
  }, [selectedScenario]);

  useEffect(() => {
    if (selectedAction) {
      setActionDraft({
        name: selectedAction.name || "",
        description: selectedAction.description || "",
        steps: Array.isArray(selectedAction.steps) ? selectedAction.steps : [],
      });
    } else {
      setActionDraft(emptyActionDraft());
    }
  }, [selectedAction]);

  const scenarioValid = scenarioDraft.name.trim().length > 0 && scenarioTargetsValid(scenarioDraft.targets, allowedFromNumbers);

  async function saveScenario() {
    if (!scenarioValid) return;
    setSaving(true);
    try {
      const payload = {
        name: scenarioDraft.name.trim(),
        description: scenarioDraft.description.trim(),
        config: {
          targets: scenarioDraft.targets.map((t) => ({
            flow_id: t.flow_id,
            total_calls: Math.max(1, Math.min(1000, Number(t.total_calls) || 1)),
            from_numbers: t.from_numbers,
            action_id: t.workflow_testing === true ? WORKFLOW_TESTING_ACTION_ID : (t.action_id || null),
            action_trigger: t.action_trigger === "agent_bridge" ? "agent_bridge" : "call_answer",
            workflow_testing: t.workflow_testing === true,
            workflow_id: t.workflow_testing === true ? (t.workflow_id || null) : null,
            workflow_name: t.workflow_testing === true ? (t.workflow_name || null) : null,
            transcription_active: t.workflow_testing === true ? t.transcription_active === true : false,
          })),
          assertions: assertionsFromDraft(scenarioDraft),
        },
      };
      const url = selectedScenario ? `${API}/scenarios/${selectedScenario.id}` : `${API}/scenarios`;
      const res = await fetch(url, {
        method: selectedScenario ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      const data = await res.json();
      notify({ title: selectedScenario ? "Scenario updated" : "Scenario created", description: payload.name, variant: "success" });
      setScenarios((prev) => (selectedScenario ? prev.map((s) => (s.id === selectedScenario.id ? data.scenario : s)) : [data.scenario, ...prev]));
      if (!selectedScenario && data.scenario?.id) setSelectedScenarioId(data.scenario.id);
    } catch (err) {
      notify({ title: "Save failed", description: err.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function deleteScenario(item) {
    if (!window.confirm(`Delete scenario "${item.name}"?`)) return;
    try {
      const res = await fetch(`${API}/scenarios/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      notify({ title: "Scenario deleted", variant: "success" });
      setScenarios((prev) => prev.filter((s) => s.id !== item.id));
      if (selectedScenarioId === item.id) setSelectedScenarioId(null);
    } catch (err) {
      notify({ title: "Delete failed", description: err.message, variant: "error" });
    }
  }

  async function startRun(item) {
    try {
      const res = await fetch(`${API}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario_id: item.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start run");
      }
      notify({ title: "Run started", description: item.name, variant: "success" });
      setActive("dashboard");
    } catch (err) {
      notify({ title: "Run failed", description: err.message, variant: "error" });
    }
  }

  const actionValid = actionDraft.name.trim().length > 0 && actionDraft.steps.length > 0;

  async function saveAction() {
    if (!actionValid) return;
    setSaving(true);
    try {
      const payload = { name: actionDraft.name.trim(), description: actionDraft.description.trim(), steps: actionDraft.steps };
      const url = selectedAction ? `${API}/actions/${selectedAction.id}` : `${API}/actions`;
      const res = await fetch(url, {
        method: selectedAction ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      const data = await res.json();
      notify({ title: selectedAction ? "Action updated" : "Action created", description: payload.name, variant: "success" });
      setActions((prev) => (selectedAction ? prev.map((a) => (a.id === selectedAction.id ? data.action : a)) : [data.action, ...prev]));
      if (!selectedAction && data.action?.id) setSelectedActionId(data.action.id);
    } catch (err) {
      notify({ title: "Save failed", description: err.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function deleteAction(item) {
    if (!window.confirm(`Delete action "${item.name}"?`)) return;
    try {
      const res = await fetch(`${API}/actions/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      notify({ title: "Action deleted", variant: "success" });
      setActions((prev) => prev.filter((a) => a.id !== item.id));
      if (selectedActionId === item.id) setSelectedActionId(null);
    } catch (err) {
      notify({ title: "Delete failed", description: err.message, variant: "error" });
    }
  }

  async function saveSettings() {
    setSaving(true);
    try {
      const res = await fetch(`${API}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: settingsDraft }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      const data = await res.json();
      setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
      setSettingsDraft({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
      notify({ title: "Settings saved", description: "Call generator settings have been persisted.", variant: "success" });
    } catch (err) {
      notify({ title: "Failed to save settings", description: err.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const flowName = useCallback((flowId) => resources.flows.find((f) => f.id === flowId)?.name || flowId || "—", [resources.flows]);
  const actionName = useCallback((actionId) => actions.find((a) => a.id === actionId)?.name || null, [actions]);

  const headerCreate = active === "scenarios"
    ? { label: "New scenario", onClick: () => setSelectedScenarioId(null) }
    : active === "actions"
      ? { label: "New action", onClick: () => setSelectedActionId(null) }
      : null;

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="Call Generator"
        badges={(
          <Badge variant="outline" className={settings.enabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"}>
            {settings.enabled ? "Enabled" : "Disabled"}
          </Badge>
        )}
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => refresh(true)} disabled={loading}>
              <IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {headerCreate ? (
              <Button size="sm" className={neutralActionClass} onClick={headerCreate.onClick} disabled={saving}>
                <IconWand className="mr-2 h-4 w-4" />
                {headerCreate.label}
              </Button>
            ) : null}
          </>
        )}
      />
      <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr) 380px` }}>
        <SectionRail items={NAV_ITEMS} activeId={active} onSelect={setActive} ariaLabel="Call generator sections" />

        {/* Main panel */}
        <section className="min-h-0 overflow-hidden rounded-2xl border bg-card/95 shadow-sm backdrop-blur flex flex-col">
          <div className="h-16 shrink-0 border-b bg-card/95 px-5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{activeMeta.label}</h2>
              <p className="text-xs text-muted-foreground">{activeMeta.description}</p>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-5">
            {active === "dashboard" ? (
              <CallGeneratorDashboardView refreshNonce={refreshNonce} />
            ) : active === "scenarios" ? (
              <ScenariosListView
                scenarios={scenarios}
                selectedScenarioId={selectedScenario?.id || null}
                setSelectedScenarioId={setSelectedScenarioId}
                flowName={flowName}
                startRun={startRun}
                deleteScenario={deleteScenario}
              />
            ) : active === "actions" ? (
              <ActionsListView
                actions={actions}
                selectedActionId={selectedAction?.id || null}
                setSelectedActionId={setSelectedActionId}
                deleteAction={deleteAction}
              />
            ) : (
              <SettingsSummaryView settings={settings} />
            )}
          </div>
        </section>

        {/* Right panel — Context Settings */}
        <aside className="min-h-0 overflow-hidden rounded-2xl border bg-card/92 shadow-sm backdrop-blur flex flex-col">
          <PanelHeader
            title={active === "dashboard" ? "Run monitor" : "Context settings"}
            description={active === "dashboard" ? "Live execution overview" : `${activeMeta.label} configuration`}
          />
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {active === "dashboard" ? (
              <div className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">
                Live calls and run progress update automatically every 2 seconds. Use Stop or Panic on a running run to halt traffic.
              </div>
            ) : active === "scenarios" ? (
              <ScenarioEditor
                draft={scenarioDraft}
                setDraft={setScenarioDraft}
                editing={Boolean(selectedScenario)}
                valid={scenarioValid}
                saving={saving}
                save={saveScenario}
                flows={resources.flows}
                actions={actions}
                allowedFromNumbers={allowedFromNumbers}
              />
            ) : active === "actions" ? (
              <ActionEditor
                draft={actionDraft}
                setDraft={setActionDraft}
                actionId={selectedAction?.id || null}
                editing={Boolean(selectedAction)}
                valid={actionValid}
                saving={saving}
                save={saveAction}
                media={resources.media}
              />
            ) : (
              <SettingsEditor
                draft={settingsDraft}
                setDraft={setSettingsDraft}
                saving={saving}
                save={saveSettings}
                inventoryNumbers={inventoryNumbers}
              />
            )}
          </div>
        </aside>
      </main>
    </AdminPageShell>
  );
}

function ScenariosListView({ scenarios, selectedScenarioId, setSelectedScenarioId, flowName, startRun, deleteScenario }) {
  if (!scenarios.length) {
    return <Empty title="No scenarios yet" description="Use New scenario in the header, configure targets in Context Settings on the right, then save." />;
  }
  return (
    <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Scenario inventory</h3>
          <p className="text-sm text-muted-foreground">Rows select configuration in the right Context Settings panel.</p>
        </div>
        <Badge variant="outline" className="bg-card">{scenarios.length} total</Badge>
      </div>
      <div className="mt-5 overflow-hidden rounded-xl border">
        <div className="grid bg-muted/45 px-3 py-2 text-xs font-semibold text-muted-foreground" style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) 96px" }}>
          <span>Name</span><span>Targets</span><span>Calls</span><span>Numbers</span><span className="text-right">Actions</span>
        </div>
        {scenarios.map((s) => {
          const targets = Array.isArray(s.config?.targets) ? s.config.targets : [];
          const totalCalls = targets.reduce((sum, t) => sum + (Number(t.total_calls) || 0), 0);
          const numbersCount = [...new Set(targets.flatMap((t) => t.from_numbers || []))].length;
          const selected = selectedScenarioId === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setSelectedScenarioId(s.id)}
              className={`grid cursor-pointer items-center border-t px-3 py-2.5 text-sm transition hover:bg-muted/40 ${selected ? "bg-sky-500/10" : ""}`}
              style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) 96px" }}
            >
              <span className="truncate font-medium">{s.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {targets.length ? targets.map((t) => flowName(t.flow_id)).join(", ") : "—"}
              </span>
              <span className="tabular-nums">{totalCalls || "—"}</span>
              <span className="tabular-nums">{numbersCount || "—"}</span>
              <span className="flex items-center justify-end gap-1">
                <Button size="icon" variant="ghost" className="h-7 w-7" title="Start run" onClick={(e) => { e.stopPropagation(); startRun(s); }}>
                  <IconPlayerPlay className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" title="Delete" onClick={(e) => { e.stopPropagation(); deleteScenario(s); }}>
                  <IconTrash className="h-3.5 w-3.5" />
                </Button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScenarioEditor({ draft, setDraft, editing, valid, saving, save, flows, actions, allowedFromNumbers }) {
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const updateTarget = (index, patch) => setDraft((d) => ({
    ...d,
    targets: d.targets.map((t, i) => (i === index ? { ...t, ...patch } : t)),
  }));
  const selectTargetFlow = (index, flowId) => {
    const info = flowWorkflowTestingInfo(flows, flowId);
    updateTarget(index, {
      flow_id: flowId,
      workflow_testing: false,
      workflow_id: info.workflow_id || "",
      workflow_name: info.workflow_name || "",
      transcription_active: info.transcription_active === true,
      action_id: "",
    });
  };
  const toggleWorkflowTesting = (index, checked) => {
    const target = draft.targets[index] || {};
    const info = flowWorkflowTestingInfo(flows, target.flow_id);
    if (!checked) {
      updateTarget(index, { workflow_testing: false, action_id: "" });
      return;
    }
    if (!info.enabled) return;
    updateTarget(index, {
      workflow_testing: true,
      action_id: WORKFLOW_TESTING_ACTION_ID,
      action_trigger: "agent_bridge",
      workflow_id: info.workflow_id || "",
      workflow_name: info.workflow_name || "",
      transcription_active: info.transcription_active === true,
    });
  };
  const addTarget = () => setDraft((d) => ({ ...d, targets: [...d.targets, emptyTarget()] }));
  const removeTarget = (index) => setDraft((d) => ({ ...d, targets: d.targets.filter((_, i) => i !== index) }));
  const fromNumberOptions = allowedFromNumbers.map((n) => ({ value: n, label: n }));

  return (
    <>
      <SettingCard icon={IconList} title={editing ? "Edit scenario" : "New scenario"} subtitle="Persisted scenario details">
        <div className="space-y-3">
          <div>
            <Label>Name<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
            <Input className="mt-1" value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="Scenario name" />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea className="mt-1" rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} placeholder="Optional description" />
          </div>
        </div>
      </SettingCard>

      {draft.targets.map((target, index) => {
        const workflowInfo = flowWorkflowTestingInfo(flows, target.flow_id);
        const canEnableWorkflowTesting = workflowInfo.enabled === true;
        const hasWorkflowAssist = workflowInfo.capable === true;
        const missingTranscription = hasWorkflowAssist && workflowInfo.transcription_active !== true;
        return (
        <SettingCard key={index} icon={IconPhoneCall} title={`Target ${index + 1}`} subtitle="Flow destination and dialing volume">
          <div className="space-y-3">
            <div>
              <Label>Target Flow<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
              <Select value={target.flow_id || ""} onValueChange={(v) => selectTargetFlow(index, v)}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select call flow" /></SelectTrigger>
                <SelectContent>
                  {flows.map((f) => <SelectItem key={f.id} value={f.id}>{f.name || f.id}</SelectItem>)}
                </SelectContent>
              </Select>
              {hasWorkflowAssist ? (
                <div className={`mt-3 rounded-xl border p-3 ${canEnableWorkflowTesting ? "bg-emerald-500/5 border-emerald-500/25" : "bg-amber-500/5 border-amber-500/25"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Label className="text-sm font-medium">Test Workflow</Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {canEnableWorkflowTesting
                          ? `LLM caller simulator will test workflow: ${workflowInfo.workflow_name || workflowInfo.workflow_id}.`
                          : missingTranscription
                            ? "This flow has Agent Assist workflow configured, but call transcription is not active on Answer or Streaming Start. Enable transcription before testing the workflow."
                            : "This flow is not ready for workflow testing."}
                      </p>
                    </div>
                    <Switch checked={target.workflow_testing === true} disabled={!canEnableWorkflowTesting} onCheckedChange={(checked) => toggleWorkflowTesting(index, checked)} />
                  </div>
                  {target.workflow_testing === true ? (
                    <Badge variant="outline" className="mt-3 bg-card">Workflow: {workflowInfo.workflow_name || target.workflow_name || target.workflow_id}</Badge>
                  ) : null}
                </div>
              ) : target.flow_id ? (
                <p className="mt-2 text-xs text-muted-foreground">Test Workflow appears when the selected flow has an active Agent Assist node connected to a workflow.</p>
              ) : null}
            </div>
            <div>
              <Label>Number of calls<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
              <Input className="mt-1" type="number" min={1} max={1000} value={target.total_calls} onChange={(e) => updateTarget(index, { total_calls: Number(e.target.value) || 1 })} />
            </div>
            <div>
              <Label>From numbers<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
              <div className="mt-1">
                <MultiSelect
                  values={target.from_numbers}
                  options={fromNumberOptions}
                  emptyLabel="No numbers enabled. Pick From Numbers in Settings first."
                  onChange={(values) => updateTarget(index, { from_numbers: values })}
                />
              </div>
              {target.from_numbers.length > 1 ? <p className="mt-1 text-xs text-muted-foreground">Calls rotate through selected numbers round-robin.</p> : null}
            </div>
            <div className={target.workflow_testing === true ? "opacity-50" : ""}>
              <Label>Action sequence<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
              <Select disabled={target.workflow_testing === true} value={target.workflow_testing === true ? WORKFLOW_TESTING_ACTION_ID : (target.action_id || "")} onValueChange={(v) => updateTarget(index, { action_id: v })}>
                <SelectTrigger className="mt-1"><SelectValue placeholder={target.workflow_testing === true ? "Disabled while Test Workflow is active" : "Select action sequence"} /></SelectTrigger>
                <SelectContent>
                  {actions.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {target.workflow_testing === true ? <p className="mt-1 text-xs text-muted-foreground">Action sequence is disabled because Test Workflow generates caller replies dynamically from agent-side transcription.</p> : null}
              {!actions.length ? <p className="mt-1 text-xs text-muted-foreground">No actions defined yet — create one in the Actions section first.</p> : null}
            </div>
            <div>
              <Label>Run actions on</Label>
              <div className="mt-1 grid gap-1 rounded-xl border bg-muted/25 p-1" role="tablist" aria-label="Run actions on">
                {[
                  { value: "call_answer", label: "Call Answer", description: "Start immediately when the flow answers — best for IVR and flow tests." },
                  { value: "agent_bridge", label: "Agent Bridge", description: "Wait until the caller is bridged to an agent — best when audio or DTMF must be heard by the live agent." },
                ].map((option) => {
                  const activeTrigger = (target.action_trigger || "call_answer") === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="tab"
                      aria-selected={activeTrigger}
                      onClick={() => updateTarget(index, { action_trigger: option.value })}
                      className={`rounded-lg border px-3 py-2 text-left transition ${activeTrigger ? "border-sky-500/50 bg-sky-500/10 shadow-sm" : "border-transparent hover:bg-background/70"}`}
                    >
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {draft.targets.length > 1 ? (
              <Button size="sm" variant="outline" className="text-rose-600" onClick={() => removeTarget(index)}>
                <IconTrash className="mr-2 h-3.5 w-3.5" />
                Remove target
              </Button>
            ) : null}
          </div>
        </SettingCard>
        );
      })}

      <Button size="sm" variant="outline" className="w-full" onClick={addTarget}>
        <IconPlus className="mr-2 h-4 w-4" />
        Add target
      </Button>

      <SettingCard icon={IconShieldCheck} title="Assertions" subtitle="Optional pass/fail checks evaluated in the run report">
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Routed to queue</Label>
            <Input className="mt-1" value={draft.assert_queue} onChange={(e) => update({ assert_queue: e.target.value })} placeholder="queue name" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label className="text-xs">Answer ≤ (s)</Label>
              <Input className="mt-1" type="number" min={1} max={600} value={draft.assert_answer_within} onChange={(e) => update({ assert_answer_within: e.target.value })} placeholder="20" />
            </div>
            <div>
              <Label className="text-xs">Abandon ≤ (%)</Label>
              <Input className="mt-1" type="number" min={0} max={100} value={draft.assert_max_abandon} onChange={(e) => update({ assert_max_abandon: e.target.value })} placeholder="5" />
            </div>
            <div>
              <Label className="text-xs">Answer ≥ (%)</Label>
              <Input className="mt-1" type="number" min={0} max={100} value={draft.assert_min_answer} onChange={(e) => update({ assert_min_answer: e.target.value })} placeholder="80" />
            </div>
          </div>
        </div>
      </SettingCard>

      <Button className="w-full" onClick={save} disabled={!valid || saving} data-testid="cg-save-scenario">
        {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}
        {editing ? "Save scenario" : "Create scenario"}
      </Button>
      {!valid ? (
        <p className="text-xs text-amber-600 dark:text-amber-300">
          Required: scenario name and at least one target with a Target Flow, at least 1 call, at least one From number, and either an Action sequence or enabled Test Workflow with active call-flow transcription.
        </p>
      ) : null}
    </>
  );
}

function ActionsListView({ actions, selectedActionId, setSelectedActionId, deleteAction }) {
  if (!actions.length) {
    return <Empty title="No actions yet" description="Use New action in the header to define a sequence: play media, speak text, or send DTMF." />;
  }
  return (
    <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Action sequences</h3>
          <p className="text-sm text-muted-foreground">Sequences for generated calls. Attach them to scenario targets and choose whether they run on answer or agent bridge.</p>
        </div>
        <Badge variant="outline" className="bg-card">{actions.length} total</Badge>
      </div>
      <div className="mt-5 space-y-2">
        {actions.map((a) => {
          const steps = Array.isArray(a.steps) ? a.steps : [];
          const selected = selectedActionId === a.id;
          return (
            <div
              key={a.id}
              onClick={() => setSelectedActionId(a.id)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-4 py-3 transition hover:bg-muted/40 ${selected ? "bg-sky-500/10 border-sky-500/40" : ""}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{a.name}</span>
                  <Badge variant="outline" className="bg-card text-xs">{a.id === WORKFLOW_TESTING_ACTION_ID ? "Protected" : `${steps.length} steps`}</Badge>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {steps.map((s, i) => `${i + 1}. ${s.type === "play_media" ? `Play ${s.media_name}` : s.type === "speak" ? `Speak "${String(s.text || "").slice(0, 24)}…"` : s.type === "workflow_testing" ? `Workflow Testing voice ${s.voice || "AWS.Polly.Joanna"}` : `DTMF ${s.digits}`}`).join("  ·  ") || "No steps"}
                </div>
              </div>
              {a.id === WORKFLOW_TESTING_ACTION_ID ? null : (
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" title="Delete" onClick={(e) => { e.stopPropagation(); deleteAction(a); }}>
                  <IconTrash className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionEditor({ draft, setDraft, actionId, editing, valid, saving, save, media }) {
  const protectedWorkflowTesting = actionId === WORKFLOW_TESTING_ACTION_ID;
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const updateStep = (index, patch) => setDraft((d) => ({ ...d, steps: d.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));
  const removeStep = (index) => setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== index) }));
  const moveStep = (index, delta) => setDraft((d) => {
    const next = [...d.steps];
    const target = index + delta;
    if (target < 0 || target >= next.length) return d;
    [next[index], next[target]] = [next[target], next[index]];
    return { ...d, steps: next };
  });
  const addStep = (type) => setDraft((d) => ({
    ...d,
    steps: [...d.steps, type === "play_media" ? { type, media_name: "" } : type === "speak" ? { type, text: "", voice: "AWS.Polly.Joanna" } : { type, digits: "" }],
  }));

  return (
    <>
      {protectedWorkflowTesting ? (
        <SettingCard icon={IconWand} title="Workflow Testing" subtitle="Protected system action">
          <p className="text-sm text-muted-foreground">
            This protected action is managed by the application. Only the caller simulation TTS voice can be changed here.
          </p>
        </SettingCard>
      ) : (
        <SettingCard icon={IconListDetails} title={editing ? "Edit action" : "New action"} subtitle="Sequential steps executed after answer">
          <div className="space-y-3">
            <div>
              <Label>Name<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
              <Input className="mt-1" value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="Action name" />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea className="mt-1" rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} placeholder="Optional description" />
            </div>
          </div>
        </SettingCard>
      )}

      {draft.steps.map((step, index) => (
        <SettingCard
          key={index}
          icon={step.type === "play_media" ? IconMusic : step.type === "speak" ? IconSpeakerphone : step.type === "workflow_testing" ? IconWand : IconActivity}
          title={`Step ${index + 1} — ${step.type === "play_media" ? "Play media" : step.type === "speak" ? "Speak text" : step.type === "workflow_testing" ? "Workflow Testing" : "Send DTMF"}`}
          subtitle={step.type === "workflow_testing" ? "Dynamic LLM caller replies for workflow testing" : "Executed in order"}
        >
          <div className="space-y-3">
            {step.type === "play_media" ? (
              <div>
                <Label>Media file<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
                <div className="mt-1">
                  <MediaFileSelector value={step.media_name || ""} onChange={(v) => updateStep(index, { media_name: v })} media={media} />
                </div>
              </div>
            ) : step.type === "speak" ? (
              <>
                <div>
                  <Label>Text to speak<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
                  <Textarea className="mt-1" rows={3} value={step.text || ""} onChange={(e) => updateStep(index, { text: e.target.value })} placeholder="This is a test call" />
                </div>
                <div>
                  <Label>Voice</Label>
                  <div className="mt-1">
                    <VoiceSelector value={step.voice} onChange={(voice) => updateStep(index, { voice })} previewText={step.text || ""} />
                  </div>
                </div>
              </>
            ) : step.type === "workflow_testing" ? (
              <div>
                <Label>Caller simulation voice</Label>
                <div className="mt-1">
                  <VoiceSelector value={step.voice} onChange={(voice) => updateStep(index, { voice })} previewText="I need to order a new medical transport for our patient." />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">This protected action is auto-seeded on startup. It uses finalized agent-side transcription and the selected Agent Assist workflow to generate the next customer utterance.</p>
              </div>
            ) : (
              <div>
                <Label>DTMF digits<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
                <Input className="mt-1 font-mono" value={step.digits || ""} onChange={(e) => updateStep(index, { digits: e.target.value })} placeholder="3467 or 1w2w3#" />
                <p className="mt-1 text-xs text-muted-foreground">Allowed: 0-9 A-D # * and w (0.5s pause).</p>
              </div>
            )}
            {protectedWorkflowTesting ? null : <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" className="h-7 w-7" title="Move up" disabled={index === 0 || step.type === "workflow_testing"} onClick={() => moveStep(index, -1)}>
                <IconArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" title="Move down" disabled={index === draft.steps.length - 1 || step.type === "workflow_testing"} onClick={() => moveStep(index, 1)}>
                <IconArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-rose-600" title="Remove step" disabled={step.type === "workflow_testing"} onClick={() => removeStep(index)}>
                <IconTrash className="h-3.5 w-3.5" />
              </Button>
            </div>}
          </div>
        </SettingCard>
      ))}

      {protectedWorkflowTesting ? null : <div className="grid grid-cols-3 gap-2">
        <Button size="sm" variant="outline" onClick={() => addStep("play_media")}>
          <IconMusic className="mr-1 h-3.5 w-3.5" />
          Media
        </Button>
        <Button size="sm" variant="outline" onClick={() => addStep("speak")}>
          <IconSpeakerphone className="mr-1 h-3.5 w-3.5" />
          Speak
        </Button>
        <Button size="sm" variant="outline" onClick={() => addStep("send_dtmf")}>
          <IconActivity className="mr-1 h-3.5 w-3.5" />
          DTMF
        </Button>
      </div>}

      <Button className="w-full" onClick={save} disabled={!valid || saving} data-testid="cg-save-action">
        {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}
        {editing ? "Save action" : "Create action"}
      </Button>
      {!valid ? <p className="text-xs text-amber-600 dark:text-amber-300">Required: action name and at least one step.</p> : null}
    </>
  );
}

function SettingsSummaryView({ settings }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
        <h3 className="text-lg font-semibold">Call generator settings</h3>
        <p className="text-sm text-muted-foreground">Global generator defaults. Edit and persist these from Context Settings on the right.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <MiniStat label="Status" value={settings.enabled ? "Enabled" : "Disabled"} icon={IconActivity} tone={settings.enabled ? "emerald" : "rose"} />
        <MiniStat label="Max concurrent calls" value={settings.max_concurrent_calls ?? 10} icon={IconPhoneCall} tone="blue" />
        <MiniStat label="Max CPS" value={settings.max_cps ?? 2} icon={IconChartBar} tone="violet" />
        <MiniStat label="Dial timeout (sec)" value={settings.dial_timeout_secs ?? 30} icon={IconClockHour4} tone="amber" />
        <MiniStat label="Max call duration (sec)" value={settings.max_call_duration_secs ?? 120} icon={IconClockHour4} tone="rose" />
        <MiniStat label="From numbers" value={(settings.from_numbers || []).length} icon={IconPhoneCall} tone="emerald" />
      </div>
      <SettingCard icon={IconPhoneCall} title="From Numbers" subtitle="Telnyx inventory numbers enabled as generator caller IDs">
        {(settings.from_numbers || []).length ? (
          <div className="flex flex-wrap gap-2">
            {settings.from_numbers.map((n) => <Badge key={n} className={telnyxNumberBadgeClass}>{n}</Badge>)}
          </div>
        ) : <p className="text-sm text-muted-foreground">No numbers enabled yet — select them in Context Settings.</p>}
      </SettingCard>
      <SettingCard icon={IconShieldCheck} title="PSTN whitelist" subtitle="Generated PSTN destinations allowed by the safety rail">
        {(settings.pstn_whitelist || []).length ? (
          <div className="flex flex-wrap gap-2">
            {settings.pstn_whitelist.map((n) => <Badge key={n} className={telnyxNumberBadgeClass}>{n}</Badge>)}
          </div>
        ) : <p className="text-sm text-muted-foreground">Empty — generated PSTN calls are fully blocked.</p>}
      </SettingCard>
    </div>
  );
}

function SettingsEditor({ draft, setDraft, saving, save, inventoryNumbers }) {
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const fromNumberOptions = inventoryNumbers.map((item) => ({
    value: item.phone_number,
    label: item.connection_name
      ? `${item.phone_number} · ${String(item.connection_name).slice(0, 24)}${String(item.connection_name).length > 24 ? "…" : ""}`
      : item.phone_number,
  }));

  return (
    <>
      <SettingCard icon={IconSettings} title="Generator" subtitle="Master switch and pacing caps">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 p-3">
            <div>
              <div className="text-sm font-medium">Enable Call Generator</div>
              <div className="text-xs text-muted-foreground">Master switch — no run can originate calls while disabled.</div>
            </div>
            <Switch checked={draft.enabled === true} onCheckedChange={(checked) => update({ enabled: checked === true })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Max concurrent</Label>
              <Input className="mt-1" type="number" min={1} max={100} value={draft.max_concurrent_calls} onChange={(e) => update({ max_concurrent_calls: Number(e.target.value) || 1 })} />
            </div>
            <div>
              <Label>Max CPS</Label>
              <Input className="mt-1" type="number" min={1} max={20} value={draft.max_cps} onChange={(e) => update({ max_cps: Number(e.target.value) || 1 })} />
            </div>
            <div>
              <Label>Dial timeout (sec)</Label>
              <Input className="mt-1" type="number" min={10} max={120} value={draft.dial_timeout_secs} onChange={(e) => update({ dial_timeout_secs: Number(e.target.value) || 30 })} />
            </div>
            <div>
              <Label>Max duration (sec)</Label>
              <Input className="mt-1" type="number" min={10} max={3600} value={draft.max_call_duration_secs} onChange={(e) => update({ max_call_duration_secs: Number(e.target.value) || 120 })} />
            </div>
          </div>
        </div>
      </SettingCard>

      <SettingCard icon={IconPhoneCall} title="From Numbers" subtitle="Telnyx inventory numbers usable as caller IDs">
        <MultiSelect
          values={Array.isArray(draft.from_numbers) ? draft.from_numbers : []}
          options={fromNumberOptions}
          emptyLabel="No active numbers found in the Telnyx inventory."
          onChange={(values) => update({ from_numbers: values })}
          showBadges={false}
        />
        <p className="mt-2 text-xs text-muted-foreground">Selected numbers are shown on the Settings card in the main panel.</p>
      </SettingCard>

      <SettingCard icon={IconShieldCheck} title="PSTN Safety" subtitle="Whitelist for generated PSTN destinations">
        <Label>One E.164 number per line</Label>
        <Textarea
          className="mt-2 font-mono text-xs"
          rows={4}
          placeholder={"+48123456789\n+12025550100"}
          value={(draft.pstn_whitelist || []).join("\n")}
          onChange={(e) => update({ pstn_whitelist: e.target.value.split("\n").map((n) => n.trim()).filter(Boolean) })}
        />
      </SettingCard>

      <Button className="w-full" onClick={save} disabled={saving} data-testid="cg-save-settings">
        {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}
        Save settings
      </Button>
    </>
  );
}
