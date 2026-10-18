"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import { notify } from "@/components/ToastNotify";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { SYSTEM_EXIT_ITEM } from "@/components/admin/SystemSectionNav";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import CallGeneratorDashboardView from "@/components/contact-center/CallGeneratorDashboardView";
import CallGeneratorLogsView from "@/components/contact-center/CallGeneratorLogsView";
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
  IconHistory,
  IconInfoCircle,
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
const DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT = "This is a neutral voice preview for workflow testing.";
const WORKFLOW_TESTING_PERSONAS = [
  { id: "neutral", label: "Neutral / cooperative" },
  { id: "angry", label: "Angry" },
  { id: "excited", label: "Excited" },
  { id: "content", label: "Content" },
  { id: "sad", label: "Sad" },
  { id: "scared", label: "Scared" },
  { id: "happy", label: "Happy" },
  { id: "enthusiastic", label: "Enthusiastic" },
  { id: "curious", label: "Curious" },
  { id: "calm", label: "Calm" },
  { id: "grateful", label: "Grateful" },
  { id: "affectionate", label: "Affectionate" },
  { id: "sarcastic", label: "Sarcastic" },
  { id: "surprised", label: "Surprised" },
  { id: "confident", label: "Confident" },
  { id: "hesitant", label: "Hesitant" },
  { id: "apologetic", label: "Apologetic" },
  { id: "determined", label: "Determined" },
  { id: "frustrated", label: "Frustrated" },
  { id: "disappointed", label: "Disappointed" },
];

// Voice families that support Expressive Mode TTS tags:
//   • Telnyx Ultra (Telnyx.Ultra.*): SSML <emotion> tags + [laughter]
//   • xAI Grok (xAI.*): inline/wrapping speech tags ([pause], <whisper>, ...)
function voiceSupportsExpressive(voice) {
  const v = String(voice || "").trim();
  return /^Telnyx\.Ultra\./i.test(v) || /^xAI\./i.test(v);
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconDashboard, description: "Active runs in real time" },
  { id: "logs", label: "Logs", icon: IconHistory, description: "Historical runs and reports" },
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
  maxCallDurationSecs: "",
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
  const tUi = useUiText();
  return (
    <div className="rounded-2xl border bg-background/85 p-4 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{tUi(subtitle)}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

const toneClasses = { emerald: "from-emerald-500/18 to-teal-500/5 text-emerald-600 dark:text-emerald-300", blue: "from-sky-500/18 to-blue-500/5 text-sky-600 dark:text-sky-300", violet: "from-violet-500/18 to-fuchsia-500/5 text-violet-600 dark:text-violet-300", amber: "from-amber-500/20 to-orange-500/5 text-amber-600 dark:text-amber-300", rose: "from-rose-500/18 to-red-500/5 text-rose-600 dark:text-rose-300" };
const telnyxNumberBadgeClass = "bg-transparent text-[#00E58F] border-[#00E58F]";

// Small info affordance: an (i) icon next to a label that reveals a description
// on hover OR click/tap. Keeps the cards uncluttered while the help text stays
// one interaction away. Uses Popover (controlled) so it works on touch + keyboard.
function InfoHint({ children, label = "More info" }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onClick={(e) => { e.preventDefault(); setOpen((v) => !v); }}
        >
          <IconInfoCircle className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-72 text-xs leading-relaxed text-muted-foreground"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

// A label with an inline InfoHint to its right.
function LabelWithHint({ children, hint }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label>{children}</Label>
      <InfoHint>{hint}</InfoHint>
    </div>
  );
}

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
  const tUi = useUiText();
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
            <span className="truncate">{selected.length ? tUi("{value0} selected", { value0: selected.length }) : tUi("Select values")}</span>
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
                <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{tUi(emptyLabel)}</div>
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
        ) : <p className="text-xs text-muted-foreground">{tUi(emptyLabel)}</p>
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
  const tUi = useUiText();
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      className="h-9 w-9 shrink-0"
      title={playing ? tUi("Stop preview") : buttonTitle}
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
  const tUi = useUiText();
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
          <SelectTrigger className="w-full min-w-0"><SelectValue placeholder={voicesLoading ? tUi("Loading…") : tUi("Provider")} /></SelectTrigger>
          <SelectContent>
            {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name || p.id}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={voicesLoading ? "" : (model?.id || "")} disabled={voicesLoading} onValueChange={(mid) => {
          const nextModel = models.find((m) => m.id === mid);
          const firstVoice = nextModel?.voices?.[0];
          onChange(firstVoice?.id || `${providerId}.${mid}.`);
        }}>
          <SelectTrigger className="w-full min-w-0"><SelectValue placeholder={voicesLoading ? tUi("Loading…") : tUi("Model")} /></SelectTrigger>
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
            <SelectTrigger className="w-full min-w-0"><SelectValue placeholder={voicesLoading ? tUi("Loading voices…") : tUi("Voice")} /></SelectTrigger>
            <SelectContent>
              {voices.map((v) => <SelectItem key={v.id} value={v.id}>{v.name || v.id}</SelectItem>)}
              {!voicesLoading && !voices.length && current ? <SelectItem value={current}>{current}</SelectItem> : null}
            </SelectContent>
          </Select>
        </div>
        <PreviewButton playing={playing} busy={busy} onClick={preview} title={tUi("Play text with selected voice")} />
      </div>
    </div>
  );
}

// Media Library file picker with an inline square Play button streaming the
// file through /api/admin/media-library/[mediaName]/stream.
function MediaFileSelector({ value, onChange, media = [] }) {
  const tUi = useUiText();
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
          <SelectTrigger className="w-full"><SelectValue placeholder={tUi("Select from Media Library")} /></SelectTrigger>
          <SelectContent>
            {media.map((m) => <SelectItem key={m.media_name} value={m.media_name}>{m.media_name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <PreviewButton playing={playing} onClick={preview} title={tUi("Play media file")} />
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
  const tUi = useUiText();
  const router = useRouter();
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
  // Custom confirm dialogs for deletes (no native window.confirm — project convention).
  // Each holds the pending item to delete, or null when closed.
  const [confirmDeleteScenario, setConfirmDeleteScenario] = useState(null);
  const [confirmDeleteAction, setConfirmDeleteAction] = useState(null);
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
        maxCallDurationSecs:
          Number(selectedScenario.config?.maxCallDurationSecs) > 0
            ? String(selectedScenario.config.maxCallDurationSecs)
            : "",
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
          ...(Number(scenarioDraft.maxCallDurationSecs) > 0
            ? { maxCallDurationSecs: Math.min(3600, Math.max(10, Math.round(Number(scenarioDraft.maxCallDurationSecs)))) }
            : {}),
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

  // Open the custom confirm dialog (project convention: no native window.confirm).
  function deleteScenario(item) {
    setConfirmDeleteScenario(item);
  }

  async function performDeleteScenario(item) {
    if (!item) return;
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

  // Open the custom confirm dialog (project convention: no native window.confirm).
  function deleteAction(item) {
    setConfirmDeleteAction(item);
  }

  async function performDeleteAction(item) {
    if (!item) return;
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
        title={tUi("Call Generator")}
        badges={(
          <Badge variant="outline" className={settings.enabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"}>
            {settings.enabled ? tUi("Enabled") : tUi("Disabled")}
          </Badge>
        )}
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => refresh(true)} disabled={loading}>
              <IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />{tUi("Refresh")}</Button>
            {headerCreate ? (
              <Button size="sm" className={neutralActionClass} onClick={headerCreate.onClick} disabled={saving}>
                <IconWand className="mr-2 h-4 w-4" />
                {tUi(headerCreate.label)}
              </Button>
            ) : null}
          </>
        )}
      />
      <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr) 380px` }}>
        <SectionRail fixedItems={[SYSTEM_EXIT_ITEM]} items={NAV_ITEMS} activeId={active} onSelect={(id) => id === "exit" ? router.push("/admin/system") : setActive(id)} ariaLabel={tUi("Call generator sections")} />

        {/* Main panel */}
        <section className="min-h-0 overflow-hidden rounded-2xl border bg-card/95 shadow-sm backdrop-blur flex flex-col">
          <div className="h-16 shrink-0 border-b bg-card/95 px-5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{tUi(activeMeta.label)}</h2>
              <p className="text-xs text-muted-foreground">{tUi(activeMeta.description)}</p>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-5">
            {active === "dashboard" ? (
              <CallGeneratorDashboardView refreshNonce={refreshNonce} />
            ) : active === "logs" ? (
              <CallGeneratorLogsView refreshNonce={refreshNonce} />
            ) : active === "scenarios" ? (
              <ScenariosListView
                scenarios={scenarios}
                selectedScenarioId={selectedScenario?.id || null}
                setSelectedScenarioId={setSelectedScenarioId}
                flowName={flowName}
                startRun={startRun}
                deleteScenario={deleteScenario}
                globalMaxCallDurationSecs={Number(settingsDraft.max_call_duration_secs) || DEFAULT_SETTINGS.max_call_duration_secs}
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
            title={active === "dashboard" ? tUi("Run monitor") : active === "logs" ? tUi("Run history") : tUi("Context settings")}
            description={active === "dashboard" ? tUi("Live execution overview") : active === "logs" ? tUi("Completed run archive") : tUi("{value0} configuration", { value0: activeMeta.label })}
          />
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {active === "dashboard" ? (
              <div className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">{tUi("Live calls and run progress update automatically every 2 seconds. Use Stop or Panic on a running run to halt traffic.")}</div>
            ) : active === "logs" ? (
              <div className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">{tUi("Historical runs that have finished, stopped, failed or been abandoned. Expand any run to see its full report — the same stat tiles as the live report. Use the pager at the bottom to change page size (10/25/50).")}</div>
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
                globalMaxCallDurationSecs={Number(settingsDraft.max_call_duration_secs) || DEFAULT_SETTINGS.max_call_duration_secs}
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

      {/* Custom confirm: Delete scenario (replaces native window.confirm) */}
      <AlertDialog open={confirmDeleteScenario !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteScenario(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tUi("Delete scenario?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeleteScenario
                ? <>{tUi("This permanently deletes the scenario ")}<span className="font-medium text-foreground">&quot;{confirmDeleteScenario.name}&quot;</span>{tUi(". This action cannot be undone.")}</>
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tUi("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { const item = confirmDeleteScenario; setConfirmDeleteScenario(null); performDeleteScenario(item); }}
            >{tUi("Delete scenario")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Custom confirm: Delete action (replaces native window.confirm) */}
      <AlertDialog open={confirmDeleteAction !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tUi("Delete action?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeleteAction
                ? <>{tUi("This permanently deletes the action ")}<span className="font-medium text-foreground">&quot;{confirmDeleteAction.name}&quot;</span>{tUi(". This action cannot be undone.")}</>
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tUi("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { const item = confirmDeleteAction; setConfirmDeleteAction(null); performDeleteAction(item); }}
            >{tUi("Delete action")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPageShell>
  );
}

function ScenariosListView({ scenarios, selectedScenarioId, setSelectedScenarioId, flowName, startRun, deleteScenario, globalMaxCallDurationSecs }) {
  const tUi = useUiText();
  if (!scenarios.length) {
    return <Empty title={tUi("No scenarios yet")} description={tUi("Use New scenario in the header, configure targets in Context Settings on the right, then save.")} />;
  }
  return (
    <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{tUi("Scenario inventory")}</h3>
          <p className="text-sm text-muted-foreground">{tUi("Rows select configuration in the right Context Settings panel.")}</p>
        </div>
        <Badge variant="outline" className="bg-card">{scenarios.length}{tUi(" total")}</Badge>
      </div>
      <div className="mt-5 overflow-hidden rounded-xl border">
        <div className="grid bg-muted/45 px-3 py-2 text-xs font-semibold text-muted-foreground" style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 96px" }}>
          <span>{tUi("Name")}</span><span>{tUi("Targets")}</span><span>{tUi("Calls")}</span><span>{tUi("Numbers")}</span><span>{tUi("Max duration")}</span><span className="text-right">{tUi("Actions")}</span>
        </div>
        {scenarios.map((s) => {
          const targets = Array.isArray(s.config?.targets) ? s.config.targets : [];
          const totalCalls = targets.reduce((sum, t) => sum + (Number(t.total_calls) || 0), 0);
          const numbersCount = [...new Set(targets.flatMap((t) => t.from_numbers || []))].length;
          const globalMaxDuration = globalMaxCallDurationSecs;
          const scenarioMaxDuration = Number(s.config?.maxCallDurationSecs) > 0 ? Number(s.config.maxCallDurationSecs) : null;
          const selected = selectedScenarioId === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setSelectedScenarioId(s.id)}
              className={`grid cursor-pointer items-center border-t px-3 py-2.5 text-sm transition hover:bg-muted/40 ${selected ? "bg-sky-500/10" : ""}`}
              style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 96px" }}
            >
              <span className="truncate font-medium">{s.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {targets.length ? targets.map((t) => flowName(t.flow_id)).join(", ") : "—"}
              </span>
              <span className="tabular-nums">{totalCalls || "—"}</span>
              <span className="tabular-nums">{numbersCount || "—"}</span>
              <span className="tabular-nums text-xs">
                {scenarioMaxDuration
                  ? tUi("{value0}s", { value0: scenarioMaxDuration })
                  : <span className="text-muted-foreground">{globalMaxDuration}{tUi("s ")}<span className="opacity-70">{tUi("(global)")}</span></span>}
              </span>
              <span className="flex items-center justify-end gap-1">
                <Button size="icon" variant="ghost" className="h-7 w-7" title={tUi("Start run")} onClick={(e) => { e.stopPropagation(); startRun(s); }}>
                  <IconPlayerPlay className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" title={tUi("Delete")} onClick={(e) => { e.stopPropagation(); deleteScenario(s); }}>
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

function ScenarioEditor({ draft, setDraft, editing, valid, saving, save, flows, actions, allowedFromNumbers, globalMaxCallDurationSecs }) {
  const tUi = useUiText();
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const selectableActions = actions.filter((a) => a.id !== WORKFLOW_TESTING_ACTION_ID);
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
      <SettingCard icon={IconList} title={editing ? tUi("Edit scenario") : tUi("New scenario")} subtitle={tUi("Persisted scenario details")}>
        <div className="space-y-3">
          <div>
            <Label>{tUi("Name")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
            <Input className="mt-1" value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder={tUi("Scenario name")} />
          </div>
          <div>
            <Label>{tUi("Description")}</Label>
            <Textarea className="mt-1" rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} placeholder={tUi("Optional description")} />
          </div>
          <div>
            <Label>{tUi("Max call duration (seconds)")}</Label>
            <Input
              type="number"
              min={10}
              max={3600}
              className="mt-1"
              value={draft.maxCallDurationSecs}
              onChange={(e) => update({ maxCallDurationSecs: e.target.value })}
              placeholder={tUi("Default: {value0}s (global setting)", { value0: globalMaxCallDurationSecs })}
            />
            <p className="mt-1 text-xs text-muted-foreground">{tUi("Per-scenario override. Leave empty to use the global setting (")}{globalMaxCallDurationSecs}{tUi("s). Telnyx enforces the hangup on the dial via time_limit_secs.")}</p>
          </div>
        </div>
      </SettingCard>

      {draft.targets.map((target, index) => {
        const workflowInfo = flowWorkflowTestingInfo(flows, target.flow_id);
        const canEnableWorkflowTesting = workflowInfo.enabled === true;
        const hasWorkflowAssist = workflowInfo.capable === true;
        const missingTranscription = hasWorkflowAssist && workflowInfo.transcription_active !== true;
        return (
        <SettingCard key={index} icon={IconPhoneCall} title={tUi("Target {value0}", { value0: index + 1 })} subtitle={tUi("Flow destination and dialing volume")}>
          <div className="space-y-3">
            <div>
              <Label>{tUi("Target Flow")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
              <Select value={target.flow_id || ""} onValueChange={(v) => selectTargetFlow(index, v)}>
                <SelectTrigger className="mt-1"><SelectValue placeholder={tUi("Select call flow")} /></SelectTrigger>
                <SelectContent>
                  {flows.map((f) => <SelectItem key={f.id} value={f.id}>{f.name || f.id}</SelectItem>)}
                </SelectContent>
              </Select>
              {hasWorkflowAssist ? (
                <div className={`mt-3 rounded-xl border p-3 ${canEnableWorkflowTesting ? "bg-emerald-500/5 border-emerald-500/25" : "bg-amber-500/5 border-amber-500/25"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Label className="text-sm font-medium">{tUi("Test Workflow")}</Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {canEnableWorkflowTesting
                          ? tUi("LLM caller simulator will test workflow: {value0}.", { value0: workflowInfo.workflow_name || workflowInfo.workflow_id })
                          : missingTranscription
                            ? tUi("This flow has Agent Assist workflow configured, but call transcription is not active on Answer or Streaming Start. Enable transcription before testing the workflow.")
                            : tUi("This flow is not ready for workflow testing.")}
                      </p>
                    </div>
                    <Switch checked={target.workflow_testing === true} disabled={!canEnableWorkflowTesting} onCheckedChange={(checked) => toggleWorkflowTesting(index, checked)} />
                  </div>
                  {target.workflow_testing === true ? (
                    <Badge variant="outline" className="mt-3 bg-card">{tUi("Workflow: ")}{workflowInfo.workflow_name || target.workflow_name || target.workflow_id}</Badge>
                  ) : null}
                </div>
              ) : target.flow_id ? (
                <p className="mt-2 text-xs text-muted-foreground">{tUi("Test Workflow appears when the selected flow has an active Agent Assist node connected to a workflow.")}</p>
              ) : null}
            </div>
            <div>
              <Label>{tUi("Number of calls")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
              <Input className="mt-1" type="number" min={1} max={1000} value={target.total_calls} onChange={(e) => updateTarget(index, { total_calls: Number(e.target.value) || 1 })} />
            </div>
            <div>
              <Label>{tUi("From numbers")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
              <div className="mt-1">
                <MultiSelect
                  values={target.from_numbers}
                  options={fromNumberOptions}
                  emptyLabel={tUi("No numbers enabled. Pick From Numbers in Settings first.")}
                  onChange={(values) => updateTarget(index, { from_numbers: values })}
                />
              </div>
              {target.from_numbers.length > 1 ? <p className="mt-1 text-xs text-muted-foreground">{tUi("Calls rotate through selected numbers round-robin.")}</p> : null}
            </div>
            {target.workflow_testing !== true ? (
              <>
                <div>
                  <Label>{tUi("Action sequence")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
                  <Select value={target.action_id || ""} onValueChange={(v) => updateTarget(index, { action_id: v })}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder={tUi("Select action sequence")} /></SelectTrigger>
                    <SelectContent>
                      {selectableActions.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {!selectableActions.length ? <p className="mt-1 text-xs text-muted-foreground">{tUi("No manual action sequences defined yet — create one in the Actions section first, or enable Test Workflow above.")}</p> : null}
                </div>
                <div>
                  <Label>{tUi("Run actions on")}</Label>
                  <div className="mt-1 grid gap-1 rounded-xl border bg-muted/25 p-1" role="radiogroup" aria-label={tUi("Run actions on")}>
                    {[
                      { value: "call_answer", label: "Call Answer", description: "Start immediately when the flow answers — best for IVR and flow tests." },
                      { value: "agent_bridge", label: "Agent Bridge", description: "Wait until the caller is bridged to an agent — best when audio or DTMF must be heard by the live agent." },
                    ].map((option) => {
                      const activeTrigger = (target.action_trigger || "call_answer") === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={activeTrigger}
                          onClick={() => updateTarget(index, { action_trigger: option.value })}
                          className={`rounded-lg border px-3 py-2 text-left transition ${activeTrigger ? "border-sky-500/50 bg-sky-500/10 shadow-sm" : "border-transparent hover:bg-background/70"}`}
                        >
                          <span className="block text-sm font-medium">{tUi(option.label)}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{tUi(option.description)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : null}
            {draft.targets.length > 1 ? (
              <Button size="sm" variant="outline" className="text-rose-600" onClick={() => removeTarget(index)}>
                <IconTrash className="mr-2 h-3.5 w-3.5" />{tUi("Remove target")}</Button>
            ) : null}
          </div>
        </SettingCard>
        );
      })}

      <Button size="sm" variant="outline" className="w-full" onClick={addTarget}>
        <IconPlus className="mr-2 h-4 w-4" />{tUi("Add target")}</Button>

      <SettingCard icon={IconShieldCheck} title={tUi("Assertions")} subtitle={tUi("Optional pass/fail checks evaluated in the run report")}>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">{tUi("Routed to queue")}</Label>
            <Input className="mt-1" value={draft.assert_queue} onChange={(e) => update({ assert_queue: e.target.value })} placeholder={tUi("queue name")} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label className="text-xs">{tUi("Answer ≤ (s)")}</Label>
              <Input className="mt-1" type="number" min={1} max={600} value={draft.assert_answer_within} onChange={(e) => update({ assert_answer_within: e.target.value })} placeholder="20" />
            </div>
            <div>
              <Label className="text-xs">{tUi("Abandon ≤ (%)")}</Label>
              <Input className="mt-1" type="number" min={0} max={100} value={draft.assert_max_abandon} onChange={(e) => update({ assert_max_abandon: e.target.value })} placeholder="5" />
            </div>
            <div>
              <Label className="text-xs">{tUi("Answer ≥ (%)")}</Label>
              <Input className="mt-1" type="number" min={0} max={100} value={draft.assert_min_answer} onChange={(e) => update({ assert_min_answer: e.target.value })} placeholder="80" />
            </div>
          </div>
        </div>
      </SettingCard>

      <Button className="w-full" onClick={save} disabled={!valid || saving} data-testid="cg-save-scenario">
        {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}
        {editing ? tUi("Save scenario") : tUi("Create scenario")}
      </Button>
      {!valid ? (
        <p className="text-xs text-amber-600 dark:text-amber-300">{tUi("Required: scenario name and at least one target with a Target Flow, at least 1 call, at least one From number, and either an Action sequence or enabled Test Workflow with active call-flow transcription.")}</p>
      ) : null}
    </>
  );
}

function ActionsListView({ actions, selectedActionId, setSelectedActionId, deleteAction }) {
  const tUi = useUiText();
  if (!actions.length) {
    return <Empty title={tUi("No actions yet")} description={tUi("Use New action in the header to define a sequence: play media, speak text, or send DTMF.")} />;
  }
  return (
    <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{tUi("Action sequences")}</h3>
          <p className="text-sm text-muted-foreground">{tUi("Sequences for generated calls. Attach them to scenario targets and choose whether they run on answer or agent bridge.")}</p>
        </div>
        <Badge variant="outline" className="bg-card">{actions.length}{tUi(" total")}</Badge>
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
                  <Badge variant="outline" className="bg-card text-xs">{a.id === WORKFLOW_TESTING_ACTION_ID ? tUi("Protected") : tUi("{value0} steps", { value0: steps.length })}</Badge>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {steps.map((s, i) => `${i + 1}. ${s.type === "play_media" ? `Play ${s.media_name}` : s.type === "speak" ? `Speak "${String(s.text || "").slice(0, 24)}…"` : s.type === "workflow_testing" ? `Workflow Testing voice ${s.voice || "AWS.Polly.Joanna"}` : s.type === "delay" ? `Delay ${(Number(s.delay_ms) || 0) / 1000}s` : `DTMF ${s.digits}`}`).join("  ·  ") || tUi("No steps")}
                </div>
              </div>
              {a.id === WORKFLOW_TESTING_ACTION_ID ? null : (
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" title={tUi("Delete")} onClick={(e) => { e.stopPropagation(); deleteAction(a); }}>
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
  const tUi = useUiText();
  const protectedWorkflowTesting = actionId === WORKFLOW_TESTING_ACTION_ID;
  const [generatingSample, setGeneratingSample] = useState(false);
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
    steps: [...d.steps, type === "play_media" ? { type, media_name: "" } : type === "speak" ? { type, text: "", voice: "AWS.Polly.Joanna" } : type === "delay" ? { type, delay_ms: 1000 } : { type, digits: "" }],
  }));

  // Generate an Expressive Mode preview sample (≤20 words) via the LLM for the
  // workflow_testing step's current persona + voice + expressive setting, then
  // drop it into the Preview sample text field. When Expressive Mode is on and
  // the voice supports it (Ultra / xAI), the sentence carries the matching tags.
  const generateSample = async (index, step) => {
    setGeneratingSample(true);
    try {
      const res = await fetch(`${API}/preview-sample`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona: step.persona || "neutral", voice: step.voice || "", expressive: step.expressive === true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.sample) throw new Error(data.error || "Generation failed");
      updateStep(index, { sample_text: data.sample });
      notify({ title: "Preview sample generated", variant: "success" });
    } catch (err) {
      notify({ title: "Could not generate sample", description: err.message, variant: "error" });
    } finally {
      setGeneratingSample(false);
    }
  };

  return (
    <>
      {protectedWorkflowTesting ? (
        <SettingCard icon={IconWand} title={tUi("Workflow Testing")} subtitle={tUi("Protected system action")}>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{tUi("Managed by the application")}</span>
            <InfoHint label={tUi("About this protected action")}>{tUi("Only the caller simulation TTS voice and preview sample text can be changed here. This protected action is auto-seeded on startup. It uses finalized agent-side transcription and the selected Agent Assist workflow to generate the next customer utterance.")}</InfoHint>
          </div>
        </SettingCard>
      ) : (
        <SettingCard icon={IconListDetails} title={editing ? tUi("Edit action") : tUi("New action")} subtitle={tUi("Sequential steps executed after answer")}>
          <div className="space-y-3">
            <div>
              <Label>{tUi("Name")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
              <Input className="mt-1" value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder={tUi("Action name")} />
            </div>
            <div>
              <Label>{tUi("Description")}</Label>
              <Textarea className="mt-1" rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} placeholder={tUi("Optional description")} />
            </div>
          </div>
        </SettingCard>
      )}

      {draft.steps.map((step, index) => (
        <SettingCard
          key={index}
          icon={step.type === "play_media" ? IconMusic : step.type === "speak" ? IconSpeakerphone : step.type === "workflow_testing" ? IconWand : step.type === "delay" ? IconClockHour4 : IconActivity}
          title={tUi("Step {value0} — {value1}", { value0: index + 1, value1: step.type === "play_media" ? tUi("Play media") : step.type === "speak" ? tUi("Speak text") : step.type === "workflow_testing" ? tUi("Workflow Testing") : step.type === "delay" ? tUi("Delay") : tUi("Send DTMF") })}
          subtitle={tUi(step.type === "workflow_testing" ? "Dynamic LLM caller replies for workflow testing" : step.type === "delay" ? "Pause between surrounding steps" : "Executed in order")}
        >
          <div className="space-y-3">
            {step.type === "play_media" ? (
              <div>
                <Label>{tUi("Media file")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
                <div className="mt-1">
                  <MediaFileSelector value={step.media_name || ""} onChange={(v) => updateStep(index, { media_name: v })} media={media} />
                </div>
              </div>
            ) : step.type === "speak" ? (
              <>
                <div>
                  <Label>{tUi("Text to speak")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
                  <Textarea className="mt-1" rows={3} value={step.text || ""} onChange={(e) => updateStep(index, { text: e.target.value })} placeholder={tUi("This is a test call")} />
                </div>
                <div>
                  <Label>{tUi("Voice")}</Label>
                  <div className="mt-1">
                    <VoiceSelector value={step.voice} onChange={(voice) => updateStep(index, { voice })} previewText={step.text || ""} />
                  </div>
                </div>
              </>
            ) : step.type === "workflow_testing" ? (
              <div className="space-y-3">
                <div>
                  <LabelWithHint hint={tUi("Used by the Play preview button to test the selected voice. Click Generate sample to get an LLM one-liner (≤20 words) in the chosen persona, with the matching Expressive Mode tags embedded.")}>{tUi("Preview sample text")}</LabelWithHint>
                  <Textarea className="mt-1" rows={3} value={step.sample_text || DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT} onChange={(e) => updateStep(index, { sample_text: e.target.value })} placeholder={DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT} />
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={generatingSample}
                      onClick={() => generateSample(index, step)}
                      title={tUi("Generate a short sample line for the selected persona, voice and Expressive Mode")}
                    >
                      {generatingSample ? <IconLoader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <IconWand className="mr-1 h-3.5 w-3.5" />}{tUi("Generate sample")}</Button>
                  </div>
                </div>
                <div>
                  <Label>{tUi("Caller simulation voice")}</Label>
                  <div className="mt-1">
                    <VoiceSelector value={step.voice} onChange={(voice) => updateStep(index, { voice, ...(voiceSupportsExpressive(voice) ? {} : { expressive: false }) })} previewText={step.sample_text || DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT} />
                  </div>
                </div>
                <div>
                  <LabelWithHint hint={tUi("Shapes how the simulated caller behaves (tone, cooperation) while still providing the information the workflow needs.")}>{tUi("Caller persona")}</LabelWithHint>
                  <div className="mt-1">
                    <Select value={step.persona || "neutral"} onValueChange={(v) => updateStep(index, { persona: v })}>
                      <SelectTrigger className="w-full"><SelectValue placeholder={tUi("Neutral / cooperative")} /></SelectTrigger>
                      <SelectContent>
                        {WORKFLOW_TESTING_PERSONAS.map((p) => <SelectItem key={p.id} value={p.id}>{tUi(p.label)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {voiceSupportsExpressive(step.voice) ? (
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="pr-3">
                      <LabelWithHint hint={tUi("xAI Grok voice: adds inline speech tags ([pause], [laugh], <whisper>…) so the caller's delivery matches the persona. When off, the LLM still role-plays the persona but the voice stays neutral (no tags).")}>{tUi("Expressive Mode")}</LabelWithHint>
                    </div>
                    <Switch checked={step.expressive === true} onCheckedChange={(checked) => updateStep(index, { expressive: checked === true })} />
                  </div>
                ) : null}
                <div>
                  <LabelWithHint hint={tUi("Pause (in seconds) after the agent finishes speaking before the generator starts the caller's reply. Use it when the simulated caller jumps in too fast. 0 = reply immediately.")}>{tUi("Reply delay (seconds)")}</LabelWithHint>
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    step={0.1}
                    className="mt-1"
                    value={Number(step.reply_delay_ms) > 0 ? (Number(step.reply_delay_ms) / 1000) : 0}
                    onChange={(e) => {
                      const secs = Math.min(10, Math.max(0, Number(e.target.value) || 0));
                      updateStep(index, { reply_delay_ms: Math.round(secs * 1000) });
                    }}
                  />
                </div>
                <div>
                  <LabelWithHint hint={tUi("How many distinct pieces of information the caller may give in one sentence. 1 = one slot per turn (default). Higher values test parallel multi-slot filling (e.g. name + facility + date of birth at once).")}>{tUi("Max answers per turn")}</LabelWithHint>
                  <Input
                    type="number"
                    min={1}
                    max={6}
                    className="mt-1"
                    value={Number(step.max_slots_per_turn) > 0 ? step.max_slots_per_turn : 1}
                    onChange={(e) => {
                      const next = Math.min(6, Math.max(1, Math.round(Number(e.target.value)) || 1));
                      updateStep(index, { max_slots_per_turn: next, ...(next <= 1 ? { randomize_slots: false } : {}) });
                    }}
                  />
                </div>
                {Number(step.max_slots_per_turn) > 1 ? (
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="pr-3">
                      <LabelWithHint hint={tUi("When on, each turn reveals a random number of pieces (1 to the max above), never exceeding the max.")}>{tUi("Randomize answers per turn")}</LabelWithHint>
                    </div>
                    <Switch checked={step.randomize_slots === true} onCheckedChange={(checked) => updateStep(index, { randomize_slots: checked === true })} />
                  </div>
                ) : null}
              </div>
            ) : step.type === "delay" ? (
              <div>
                <Label>{tUi("Delay (seconds)")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
                <Input
                  type="number"
                  min={0.1}
                  max={30}
                  step={0.1}
                  className="mt-1"
                  value={Number(step.delay_ms) > 0 ? (Number(step.delay_ms) / 1000) : 1}
                  onChange={(e) => {
                    const secs = Math.min(30, Math.max(0.1, Number(e.target.value) || 1));
                    updateStep(index, { delay_ms: Math.round(secs * 1000) });
                  }}
                />
                <p className="mt-1 text-xs text-muted-foreground">{tUi("Pauses the sequence before the next step (Media, Speak, DTMF…). 0.1–30s.")}</p>
              </div>
            ) : (
              <div>
                <Label>{tUi("DTMF digits")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
                <Input className="mt-1 font-mono" value={step.digits || ""} onChange={(e) => updateStep(index, { digits: e.target.value })} placeholder={tUi("3467 or 1w2w3#")} />
                <p className="mt-1 text-xs text-muted-foreground">{tUi("Allowed: 0-9 A-D # * and w (0.5s pause).")}</p>
              </div>
            )}
            {protectedWorkflowTesting ? null : <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" className="h-7 w-7" title={tUi("Move up")} disabled={index === 0 || step.type === "workflow_testing"} onClick={() => moveStep(index, -1)}>
                <IconArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" title={tUi("Move down")} disabled={index === draft.steps.length - 1 || step.type === "workflow_testing"} onClick={() => moveStep(index, 1)}>
                <IconArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-rose-600" title={tUi("Remove step")} disabled={step.type === "workflow_testing"} onClick={() => removeStep(index)}>
                <IconTrash className="h-3.5 w-3.5" />
              </Button>
            </div>}
          </div>
        </SettingCard>
      ))}

      {protectedWorkflowTesting ? null : <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant="outline" onClick={() => addStep("play_media")}>
          <IconMusic className="mr-1 h-3.5 w-3.5" />{tUi("Media")}</Button>
        <Button size="sm" variant="outline" onClick={() => addStep("speak")}>
          <IconSpeakerphone className="mr-1 h-3.5 w-3.5" />{tUi("Speak")}</Button>
        <Button size="sm" variant="outline" onClick={() => addStep("send_dtmf")}>
          <IconActivity className="mr-1 h-3.5 w-3.5" />{tUi("DTMF")}</Button>
        <Button size="sm" variant="outline" onClick={() => addStep("delay")}>
          <IconClockHour4 className="mr-1 h-3.5 w-3.5" />{tUi("Delay")}</Button>
      </div>}

      <Button className="w-full" onClick={save} disabled={!valid || saving} data-testid="cg-save-action">
        {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}
        {editing ? tUi("Save action") : tUi("Create action")}
      </Button>
      {!valid ? <p className="text-xs text-amber-600 dark:text-amber-300">{tUi("Required: action name and at least one step.")}</p> : null}
    </>
  );
}

function SettingsSummaryView({ settings }) {
  const tUi = useUiText();
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
        <h3 className="text-lg font-semibold">{tUi("Call generator settings")}</h3>
        <p className="text-sm text-muted-foreground">{tUi("Global generator defaults. Edit and persist these from Context Settings on the right.")}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <MiniStat label={tUi("Status")} value={settings.enabled ? tUi("Enabled") : tUi("Disabled")} icon={IconActivity} tone={settings.enabled ? "emerald" : "rose"} />
        <MiniStat label={tUi("Max concurrent calls")} value={settings.max_concurrent_calls ?? 10} icon={IconPhoneCall} tone="blue" />
        <MiniStat label={tUi("Max CPS")} value={settings.max_cps ?? 2} icon={IconChartBar} tone="violet" />
        <MiniStat label={tUi("Dial timeout (sec)")} value={settings.dial_timeout_secs ?? 30} icon={IconClockHour4} tone="amber" />
        <MiniStat label={tUi("Max call duration (sec)")} value={settings.max_call_duration_secs ?? 120} icon={IconClockHour4} tone="rose" />
        <MiniStat label={tUi("From numbers")} value={(settings.from_numbers || []).length} icon={IconPhoneCall} tone="emerald" />
      </div>
      <SettingCard icon={IconPhoneCall} title={tUi("From Numbers")} subtitle={tUi("Telnyx inventory numbers enabled as generator caller IDs")}>
        {(settings.from_numbers || []).length ? (
          <div className="flex flex-wrap gap-2">
            {settings.from_numbers.map((n) => <Badge key={n} className={telnyxNumberBadgeClass}>{n}</Badge>)}
          </div>
        ) : <p className="text-sm text-muted-foreground">{tUi("No numbers enabled yet — select them in Context Settings.")}</p>}
      </SettingCard>
      <SettingCard icon={IconShieldCheck} title={tUi("PSTN whitelist")} subtitle={tUi("Generated PSTN destinations allowed by the safety rail")}>
        {(settings.pstn_whitelist || []).length ? (
          <div className="flex flex-wrap gap-2">
            {settings.pstn_whitelist.map((n) => <Badge key={n} className={telnyxNumberBadgeClass}>{n}</Badge>)}
          </div>
        ) : <p className="text-sm text-muted-foreground">{tUi("Empty — generated PSTN calls are fully blocked.")}</p>}
      </SettingCard>
    </div>
  );
}

function SettingsEditor({ draft, setDraft, saving, save, inventoryNumbers }) {
  const tUi = useUiText();
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const fromNumberOptions = inventoryNumbers.map((item) => ({
    value: item.phone_number,
    label: item.connection_name
      ? `${item.phone_number} · ${String(item.connection_name).slice(0, 24)}${String(item.connection_name).length > 24 ? "…" : ""}`
      : item.phone_number,
  }));

  return (
    <>
      <SettingCard icon={IconSettings} title={tUi("Generator")} subtitle={tUi("Master switch and pacing caps")}>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 p-3">
            <div>
              <div className="text-sm font-medium">{tUi("Enable Call Generator")}</div>
              <div className="text-xs text-muted-foreground">{tUi("Master switch — no run can originate calls while disabled.")}</div>
            </div>
            <Switch checked={draft.enabled === true} onCheckedChange={(checked) => update({ enabled: checked === true })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tUi("Max concurrent")}</Label>
              <Input className="mt-1" type="number" min={1} max={100} value={draft.max_concurrent_calls} onChange={(e) => update({ max_concurrent_calls: Number(e.target.value) || 1 })} />
            </div>
            <div>
              <Label>{tUi("Max CPS")}</Label>
              <Input className="mt-1" type="number" min={1} max={20} value={draft.max_cps} onChange={(e) => update({ max_cps: Number(e.target.value) || 1 })} />
            </div>
            <div>
              <Label>{tUi("Dial timeout (sec)")}</Label>
              <Input className="mt-1" type="number" min={10} max={120} value={draft.dial_timeout_secs} onChange={(e) => update({ dial_timeout_secs: Number(e.target.value) || 30 })} />
            </div>
            <div>
              <Label>{tUi("Max duration (sec)")}</Label>
              <Input className="mt-1" type="number" min={10} max={3600} value={draft.max_call_duration_secs} onChange={(e) => update({ max_call_duration_secs: Number(e.target.value) || 120 })} />
            </div>
          </div>
        </div>
      </SettingCard>

      <SettingCard icon={IconPhoneCall} title={tUi("From Numbers")} subtitle={tUi("Telnyx inventory numbers usable as caller IDs")}>
        <MultiSelect
          values={Array.isArray(draft.from_numbers) ? draft.from_numbers : []}
          options={fromNumberOptions}
          emptyLabel={tUi("No active numbers found in the Telnyx inventory.")}
          onChange={(values) => update({ from_numbers: values })}
          showBadges={false}
        />
        <p className="mt-2 text-xs text-muted-foreground">{tUi("Selected numbers are shown on the Settings card in the main panel.")}</p>
      </SettingCard>

      <SettingCard icon={IconShieldCheck} title={tUi("PSTN Safety")} subtitle={tUi("Whitelist for generated PSTN destinations")}>
        <Label>{tUi("One E.164 number per line")}</Label>
        <Textarea
          className="mt-2 font-mono text-xs"
          rows={4}
          placeholder={"+48123456789\n+12025550100"}
          value={(draft.pstn_whitelist || []).join("\n")}
          onChange={(e) => update({ pstn_whitelist: e.target.value.split("\n").map((n) => n.trim()).filter(Boolean) })}
        />
      </SettingCard>

      <Button className="w-full" onClick={save} disabled={saving} data-testid="cg-save-settings">
        {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}{tUi("Save settings")}</Button>
    </>
  );
}
