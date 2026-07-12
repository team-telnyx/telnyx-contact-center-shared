"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  IconActivity,
  IconCheck,
  IconChartBar,
  IconChevronDown,
  IconCopy,
  IconDeviceFloppy,
  IconDeviceMobileMessage,
  IconGitBranch,
  IconHistory,
  IconLink,
  IconLock,
  IconLogout,
  IconMessageCircle,
  IconPhone,
  IconRobot,
  IconSettings,
  IconSparkles,
  IconTrash,
  IconVolume,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionRail, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import AgentSettingsPanel from "@/components/assistants/AgentSettingsPanel";
import AssistantChatPanel from "@/components/assistants/AssistantChatPanel";
import AssistantPhoneWidget from "@/components/assistants/AssistantPhoneWidget";
import AssistantConversationsPanel from "@/components/assistants/AssistantConversationsPanel";
import AssistantDashboardTab from "@/components/assistants/AssistantDashboardTab";
import TrafficDistributionDialog from "@/components/assistants/TrafficDistributionDialog";
import VoiceTab from "@/components/assistants/VoiceTab";
import AssistantWorkflowTab from "@/components/assistants/AssistantWorkflowTab";
import IntegrationsTab from "@/components/assistants/IntegrationsTab";
import InsightsTab from "@/components/assistants/InsightsTab";
import CallingTab from "@/components/assistants/CallingTab";
import MessagingTab from "@/components/assistants/MessagingTab";
import WidgetTab from "@/components/assistants/WidgetTab";
import PrivacyTab from "@/components/assistants/PrivacyTab";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const RAIL_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconChartBar, description: "Assistant overview and recent activity" },
  { id: "agent", label: "Agent", icon: IconRobot, description: "Model, instructions, greeting, and variables" },
  { id: "voice", label: "Voice", icon: IconVolume, description: "Voice and transcription configuration" },
  { id: "workflow", label: "Workflow", icon: IconGitBranch, description: "Conversation workflow configuration" },
  { id: "integrations", label: "Integrations", icon: IconLink, description: "Tools, webhooks, and integrations" },
  { id: "insights", label: "Insights", icon: IconSparkles, description: "Post-conversation insight settings" },
  { id: "calling", label: "Calling", icon: IconPhone, description: "Telephony and calling behavior" },
  { id: "messaging", label: "Messaging", icon: IconDeviceMobileMessage, description: "Messaging profile configuration" },
  { id: "widget", label: "Widget", icon: IconSettings, description: "Browser calling widget" },
  { id: "privacy", label: "Privacy", icon: IconLock, description: "Recording and data controls" },
  { id: "conversations", label: "Conversations", icon: IconMessageCircle, description: "Assistant conversation history" },
];

const EXIT_RAIL_ITEM = {
  id: "exit",
  label: "Exit",
  icon: IconLogout,
  description: "Return to the AI Assistants list",
  tone: "exit",
};

const DEFAULT_ASSISTANT = {
  name: "",
  description: "",
  model: "",
  instructions: "",
  greeting: "",
  dynamic_variables: {},
  tools: [],
  transcription: { model: "" },
  voice_settings: {},
  telephony: {},
  messaging: {},
  privacy_settings: {},
  insight_settings: {},
};

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function snapshot(value) {
  return JSON.stringify(stableValue(value));
}

function payloadForSave(values) {
  const telephony = JSON.parse(JSON.stringify(values.telephony || {}));
  const voicemail = telephony.voicemail_detection;
  if (voicemail && typeof voicemail.on_voicemail_detected === "string") {
    const actions = { stop: "stop_assistant", leave_message: "leave_message_and_stop_assistant", continue: "continue_assistant" };
    const action = actions[voicemail.on_voicemail_detected] || "stop_assistant";
    telephony.voicemail_detection = { on_voicemail_detected: { action } };
    if (action === "leave_message_and_stop_assistant" && voicemail.voicemail_message?.trim()) {
      telephony.voicemail_detection.on_voicemail_detected.voicemail_message = { type: "message", message: voicemail.voicemail_message.trim() };
    }
  }
  const voiceProvider = String(values.voice || "").split(".")[0].toLowerCase();
  const voiceSettings = {
    voice: values.voice || undefined,
    voice_speed: Number(values.voice_speed || 1),
    api_key_ref: values.voice_api_key_ref || undefined,
    background_audio: values.background_audio || { type: "predefined_media", value: "silence" },
    ...(values.elevenlabs_settings || {}),
    language_boost: voiceProvider === "minimax" ? values.language_boost || "auto" : undefined,
    language: voiceProvider === "xai" ? values.voice_language || "auto" : undefined,
    pronunciation_dict_id: values.pronunciation_dict_id || undefined,
    expressive_mode: values.expressive_mode ?? undefined,
  };
  const payload = {
    name: values.name,
    description: values.description || undefined,
    model: values.model,
    greeting: values.greeting || "",
    instructions: values.instructions || "",
    tools: values.tools || [],
    integrations: values.integrations || undefined,
    mcp_servers: values.mcp_servers || undefined,
    conversation_flow: values.conversation_flow || undefined,
    dynamic_variables_webhook_url: values.dynamic_variables_webhook_url || "",
    dynamic_variables: values.dynamic_variables || {},
    dynamic_variables_target: values.dynamic_variables_target || "contacts",
    llm_api_key_ref: values.llm_api_key_ref || undefined,
    fallback_config: values.fallback_enabled ? { model: values.fallback_model || "", llm_api_key_ref: values.fallback_llm_api_key_ref || "" } : { model: "", llm_api_key_ref: "" },
    voice_settings: voiceSettings,
    transcription: values.transcription || undefined,
    telephony_settings: telephony,
    messaging_settings: values.messaging || undefined,
    insight_settings: values.insight_settings || undefined,
    privacy_settings: values.privacy_settings || undefined,
    interruption_settings: values.interruption_settings || undefined,
    enabled_features: values.enabled_features?.length ? values.enabled_features : undefined,
    widget_settings: Object.keys(values.widget_settings || {}).length ? values.widget_settings : undefined,
  };
  Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
  return payload;
}

function assistantForEditor(assistant = {}) {
  const voiceSettings = assistant.voice_settings || {};
  return {
    ...DEFAULT_ASSISTANT,
    ...assistant,
    voice: voiceSettings.voice || assistant.voice || "",
    voice_speed: voiceSettings.voice_speed ?? 1,
    voice_api_key_ref: voiceSettings.api_key_ref || "",
    background_audio: voiceSettings.background_audio || { type: "predefined_media", value: "silence", volume: 0.5 },
    elevenlabs_settings: {
      temperature: voiceSettings.temperature,
      similarity_boost: voiceSettings.similarity_boost,
      style: voiceSettings.style,
      speed: voiceSettings.speed,
      use_speaker_boost: voiceSettings.use_speaker_boost,
    },
    language_boost: voiceSettings.language_boost || "",
    voice_language: voiceSettings.language || "",
    pronunciation_dict_id: voiceSettings.pronunciation_dict_id || "",
    expressive_mode: voiceSettings.expressive_mode ?? false,
    telephony: assistant.telephony_settings || assistant.telephony || {},
    messaging: assistant.messaging_settings || assistant.messaging || {},
    enabled_features: Array.isArray(assistant.enabled_features) ? assistant.enabled_features : [],
    widget_settings: assistant.widget_settings || {},
    fallback_enabled: Boolean(assistant.fallback_config?.model),
    fallback_model: assistant.fallback_config?.model || "",
    fallback_llm_api_key_ref: assistant.fallback_config?.llm_api_key_ref || "",
  };
}

function AssistantIdBadge({ assistantId }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(assistantId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return <Badge variant="outline" className="gap-2 py-1 pl-2.5 pr-1 font-mono text-xs"><span>{assistantId}</span><button type="button" onClick={copy} className="rounded p-1 hover:bg-muted" aria-label="Copy assistant ID">{copied ? <IconCheck className="size-3.5 text-emerald-500" /> : <IconCopy className="size-3.5" />}</button></Badge>;
}

function SectionCard({ title, description, children, className = "" }) {
  return <Card className={className}><CardHeader className="pb-3"><CardTitle className="text-lg">{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader><CardContent className="space-y-5">{children}</CardContent></Card>;
}

function FixedRailCard({ children, scroll = true }) {
  return <Card className="flex h-full min-h-0 w-full flex-col overflow-hidden"><CardContent className="h-full min-h-0 flex-1 p-4"><div className={scroll ? "h-full min-h-0 overflow-y-auto pr-1" : "h-full min-h-0 overflow-hidden"}>{children}</div></CardContent></Card>;
}

function ConversationsPanel({ assistantId, compact = false }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(Boolean(assistantId));

  useEffect(() => {
    if (!assistantId) return;
    let cancelled = false;
    fetch("/api/ai/conversations?pageSize=100&pageNumber=1", { cache: "no-store" })
      .then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok) throw new Error(data?.error || "Failed to load conversations");
        const all = Array.isArray(data.items) ? data.items : [];
        const filtered = all.filter((conversation) => {
          const candidates = [conversation.assistant_id, conversation.metadata?.assistant_id, conversation.metadata?.assistantId];
          return candidates.some((value) => value === assistantId);
        });
        if (!cancelled) setItems(filtered);
      })
      .catch(() => !cancelled && setItems([]))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [assistantId]);

  if (!assistantId) return <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">Save the assistant to view conversations.</div>;
  if (loading) return <div className="space-y-2">{Array.from({ length: compact ? 3 : 6 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>;
  const displayed = compact ? items.slice(0, 5) : items;
  return <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Channel</TableHead><TableHead>Created</TableHead><TableHead>ID</TableHead></TableRow></TableHeader><TableBody>{displayed.map((conversation) => <TableRow key={conversation.id}><TableCell>{conversation.name || "Conversation"}</TableCell><TableCell>{conversation.channel || conversation.metadata?.channel || "—"}</TableCell><TableCell>{conversation.created_at ? new Date(conversation.created_at).toLocaleString() : "—"}</TableCell><TableCell className="max-w-64 truncate font-mono text-xs">{conversation.id}</TableCell></TableRow>)}{!displayed.length && <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No conversations found for this assistant.</TableCell></TableRow>}</TableBody></Table></div>;
}

export default function AssistantEditor({ mode, assistantId: initialAssistantId = "" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isCreate = mode === "create";
  const skipLeaveGuardRef = useRef(false);
  const [assistantId, setAssistantId] = useState(initialAssistantId);
  const [values, setValues] = useState(DEFAULT_ASSISTANT);
  const [savedSnapshot, setSavedSnapshot] = useState(snapshot(DEFAULT_ASSISTANT));
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(!isCreate);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState("/admin/ai-assistants");
  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [newVersionName, setNewVersionName] = useState("");
  const [trafficOpen, setTrafficOpen] = useState(false);
  const [dashboardSummaryByAssistant, setDashboardSummaryByAssistant] = useState({});
  const [dashboardAnalyticsByAssistant, setDashboardAnalyticsByAssistant] = useState({});
  const requestedSection = searchParams.get("section");
  const [activeSection, setActiveSection] = useState(RAIL_ITEMS.some((item) => item.id === requestedSection) ? requestedSection : "dashboard");
  const dirty = snapshot(values) !== savedSnapshot;

  useEffect(() => {
    fetch("/api/ai/models", { cache: "no-store" }).then((response) => response.json()).then((data) => setModels(Array.isArray(data.models) ? data.models : [])).catch(() => setModels([]));
  }, []);

  useEffect(() => {
    if (isCreate || !assistantId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}`, { cache: "no-store" })
      .then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok || data?.ok === false) throw new Error(data?.error || "Assistant not found");
        const next = assistantForEditor(data.assistant || {});
        if (!cancelled) { setValues(next); setSavedSnapshot(snapshot(next)); }
      })
      .catch((error) => !cancelled && notify({ title: "Could not load assistant", description: error.message, variant: "error" }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [assistantId, isCreate]);

  useEffect(() => {
    function beforeUnload(event) {
      if (!dirty || skipLeaveGuardRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;

    function interceptInternalNavigation(event) {
      if (skipLeaveGuardRef.current) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;

      const destination = new URL(link.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const target = `${destination.pathname}${destination.search}${destination.hash}`;
      if (target === current) return;

      event.preventDefault();
      event.stopPropagation();
      setLeaveTarget(target);
      setLeaveOpen(true);
    }

    document.addEventListener("click", interceptInternalNavigation, true);
    return () => document.removeEventListener("click", interceptInternalNavigation, true);
  }, [dirty]);

  function selectSection(section) {
    if (section === "exit") {
      leaveEditor();
      return;
    }
    setActiveSection(section);
    const params = new URLSearchParams(searchParams.toString());
    params.set("section", section);
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
    if (assistantId) localStorage.setItem(`admin.ai-assistants.section.${assistantId}`, section);
  }

  useEffect(() => {
    if (requestedSection || !assistantId) return;
    const stored = localStorage.getItem(`admin.ai-assistants.section.${assistantId}`);
    if (RAIL_ITEMS.some((item) => item.id === stored)) setActiveSection(stored);
  }, [assistantId, requestedSection]);

  function leaveEditor() {
    if (dirty) {
      setLeaveTarget("/admin/ai-assistants");
      setLeaveOpen(true);
      return;
    }
    router.push("/admin/ai-assistants");
  }

  function confirmLeave() {
    const target = leaveTarget || "/admin/ai-assistants";
    skipLeaveGuardRef.current = true;
    setLeaveOpen(false);
    window.location.assign(target);
  }

  async function save({ asNewVersion = false, versionName = "" } = {}) {
    if (!values.name?.trim()) { selectSection("agent"); notify({ title: "Assistant name is required", variant: "warning" }); return; }
    if (!values.model?.trim()) { selectSection("agent"); notify({ title: "Assistant model is required", variant: "warning" }); return; }
    setSaving(true);
    try {
      const url = isCreate && !assistantId ? "/api/ai/assistants" : `/api/ai/assistants/${encodeURIComponent(assistantId)}`;
      const payload = payloadForSave(values);
      if (asNewVersion) {
        payload.promote_to_main = false;
        if (versionName.trim()) payload.version_name = versionName.trim();
      }
      const response = await fetch(url, { method: isCreate && !assistantId ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) throw new Error(data?.error || "Save failed");
      const saved = { ...values, ...(data.assistant || {}) };
      const nextId = data.assistant?.id || assistantId;
      setValues(saved); setSavedSnapshot(snapshot(saved)); setAssistantId(nextId);
      notify({ title: asNewVersion ? "New version saved" : isCreate && !assistantId ? "Assistant created" : "Assistant saved", description: saved.name, variant: "success" });
      if (asNewVersion) { setNewVersionOpen(false); setNewVersionName(""); loadVersions(); }
      if (isCreate && nextId) router.replace(`/admin/ai-assistants/${encodeURIComponent(nextId)}?section=${activeSection}`);
    } catch (error) {
      notify({ title: "Save failed", description: error.message, variant: "error" });
    } finally { setSaving(false); }
  }

  async function loadVersions() {
    if (!assistantId) return;
    setVersionsLoading(true);
    try {
      const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/versions`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Could not load versions");
      setVersions(Array.isArray(data.versions) ? data.versions : []);
    } catch (error) { notify({ title: "Could not load versions", description: error.message, variant: "error" }); }
    finally { setVersionsLoading(false); }
  }

  async function promoteVersion(versionId) {
    setPromoting(true);
    try {
      const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/versions/${encodeURIComponent(versionId)}/promote`, { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Promote failed");
      notify({ title: "Version promoted", variant: "success" });
      const refreshed = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}`, { cache: "no-store" }).then((result) => result.json());
      if (refreshed?.assistant) { const next = assistantForEditor(refreshed.assistant); setValues(next); setSavedSnapshot(snapshot(next)); }
      await loadVersions();
    } catch (error) { notify({ title: "Promote failed", description: error.message, variant: "error" }); }
    finally { setPromoting(false); }
  }

  async function cloneAssistant() {
    if (!assistantId) return;
    setCloning(true);
    try {
      const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/clone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `${values.name || "Assistant"} (copy)` }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Clone failed");
      notify({ title: "Assistant cloned", variant: "success" });
      if (data.assistant?.id) router.push(`/admin/ai-assistants/${encodeURIComponent(data.assistant.id)}`);
    } catch (error) { notify({ title: "Clone failed", description: error.message, variant: "error" }); }
    finally { setCloning(false); }
  }

  function callAssistant() {
    if (!assistantId) return notify({ title: "Save the assistant before calling", variant: "warning" });
    setShowPhone(true);
  }

  async function remove() {
    if (!assistantId) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) throw new Error(data?.error || "Delete failed");
      notify({ title: "Assistant deleted", description: values.name, variant: "success" });
      router.push("/admin/ai-assistants");
    } catch (error) { notify({ title: "Delete failed", description: error.message, variant: "error" }); }
    finally { setDeleting(false); setDeleteOpen(false); }
  }

  const headerActions = <><Button variant="outline" onClick={() => assistantId ? setShowChat(true) : notify({ title: "Save the assistant before chatting", variant: "warning" })}><IconMessageCircle className="size-4" />Chat</Button><Button variant="outline" onClick={callAssistant}><IconPhone className="size-4" />Call</Button>{assistantId ? <Button variant="outline" onClick={cloneAssistant} disabled={cloning}><IconCopy className="size-4" />{cloning ? "Cloning…" : "Clone"}</Button> : null}{assistantId ? <DropdownMenu onOpenChange={(open) => open && loadVersions()}><DropdownMenuTrigger asChild><Button variant="outline" disabled={promoting}><IconHistory className="size-4" />Switch Version<IconChevronDown className="size-3" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-64">{versionsLoading ? <DropdownMenuItem disabled>Loading versions…</DropdownMenuItem> : !versions.length ? <DropdownMenuItem disabled>No versions found</DropdownMenuItem> : versions.map((version, index) => { const current = version.is_main_version === true || version.is_current === true || version.current === true; const id = version.version_id || version.version_number || version.id || String(index); return <DropdownMenuItem key={id} disabled={current || promoting} onClick={() => !current && promoteVersion(id)} className="flex flex-col items-start"><span>{version.version_name || `Version ${versions.length - index}`}{current ? <span className="ml-2 text-xs text-emerald-500">(current)</span> : null}</span><span className="text-xs text-muted-foreground">{version.created_at ? new Date(version.created_at).toLocaleDateString() : ""}</span></DropdownMenuItem>; })}</DropdownMenuContent></DropdownMenu> : null}{assistantId ? <Button variant="outline" onClick={() => { loadVersions(); setTrafficOpen(true); }}><IconChartBar className="size-4" />Traffic %</Button> : null}{assistantId ? <Button variant="outline" className="text-destructive" onClick={() => setDeleteOpen(true)}><IconTrash className="size-4" />Delete</Button> : null}<Button variant="outline" onClick={leaveEditor}>Cancel</Button><div className="flex"><Button onClick={() => save()} disabled={saving || !dirty} className="rounded-r-none border-r-0">{saving ? "Saving…" : "Save"}</Button><DropdownMenu><DropdownMenuTrigger asChild><Button disabled={saving || !dirty} className="rounded-l-none border-l border-primary-foreground/20 px-2"><IconChevronDown className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => save()}><IconDeviceFloppy className="mr-2 size-4" />Save (promote to main)</DropdownMenuItem>{assistantId ? <DropdownMenuItem onClick={() => setNewVersionOpen(true)}><IconGitBranch className="mr-2 size-4" />Save as New Version</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu></div></>;

  function renderSection() {
    if (activeSection === "dashboard") return <AssistantDashboardTab assistantId={assistantId} values={values} summaryState={dashboardSummaryByAssistant[assistantId || "draft"]} onSummaryStateChange={setDashboardSummaryByAssistant} analyticsState={dashboardAnalyticsByAssistant[assistantId || "draft"]} onAnalyticsStateChange={setDashboardAnalyticsByAssistant} />;

    if (activeSection === "agent") return <AgentSettingsPanel assistantId={assistantId} values={values} setValues={setValues} models={models} />;
    if (activeSection === "voice") return <FixedRailCard><VoiceTab values={values} setValues={setValues} /></FixedRailCard>;
    if (activeSection === "workflow") return <FixedRailCard scroll={false}><AssistantWorkflowTab values={values} setValues={setValues} assistantId={assistantId} /></FixedRailCard>;
    if (activeSection === "integrations") return <FixedRailCard><IntegrationsTab values={values} setValues={setValues} assistantId={assistantId} /></FixedRailCard>;
    if (activeSection === "insights") return <FixedRailCard><InsightsTab values={values} setValues={setValues} isCreate={isCreate} /></FixedRailCard>;
    if (activeSection === "calling") return <div className="h-full min-h-0 overflow-hidden"><CallingTab values={values} setValues={setValues} /></div>;
    if (activeSection === "messaging") return <div className="h-full min-h-0 overflow-hidden"><MessagingTab values={values} setValues={setValues} /></div>;
    if (activeSection === "widget") return <FixedRailCard><WidgetTab values={values} setValues={setValues} assistantId={assistantId} /></FixedRailCard>;
    if (activeSection === "privacy") return <FixedRailCard><PrivacyTab values={values} setValues={setValues} /></FixedRailCard>;

    return <AssistantConversationsPanel assistantId={assistantId} />;
  }

  if (loading) return <AdminPageShell><AdminPageHeader title="AI Assistant" icon={IconRobot} /><div className="space-y-3 p-6"><Skeleton className="h-20 w-full" /><Skeleton className="h-[480px] w-full" /></div></AdminPageShell>;

  return <AdminPageShell><AdminPageHeader title={isCreate && !assistantId ? "New AI Assistant" : values.name || "AI Assistant"} icon={IconRobot} badges={<>{assistantId ? <AssistantIdBadge assistantId={assistantId} /> : <Badge variant="secondary">Draft</Badge>}{dirty ? <Badge className="bg-amber-500 text-black hover:bg-amber-500">Unsaved</Badge> : <Badge variant="secondary">Saved</Badge>}</>} actions={headerActions} /><main className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3" style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}><SectionRail fixedItems={[EXIT_RAIL_ITEM]} items={RAIL_ITEMS} activeId={activeSection} onSelect={selectSection} ariaLabel="Assistant configuration sections" /><section className="h-full min-h-0 overflow-hidden pr-1">{renderSection()}</section></main><AlertDialog open={leaveOpen} onOpenChange={(open) => { setLeaveOpen(open); if (!open) setLeaveTarget("/admin/ai-assistants"); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Unsaved Changes</AlertDialogTitle><AlertDialogDescription>You have unsaved changes. Are you sure you want to leave? All unsaved changes will be lost.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmLeave}>Leave without saving</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog><AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete assistant?</AlertDialogTitle><AlertDialogDescription>This permanently deletes {values.name || assistantId} from Telnyx.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleting} onClick={remove}>{deleting ? "Deleting…" : "Delete"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog><Dialog open={newVersionOpen} onOpenChange={setNewVersionOpen}><DialogContent><DialogHeader><DialogTitle>Save as New Version</DialogTitle><DialogDescription>Creates a new version without changing the current live version.</DialogDescription></DialogHeader><div className="space-y-2 py-2"><label className="text-sm font-medium">Version Name (optional)</label><Input placeholder="e.g. v2 with updated prompts" value={newVersionName} onChange={(event) => setNewVersionName(event.target.value)} /></div><DialogFooter><Button variant="outline" onClick={() => { setNewVersionOpen(false); setNewVersionName(""); }} disabled={saving}>Cancel</Button><Button onClick={() => save({ asNewVersion: true, versionName: newVersionName })} disabled={saving}>{saving ? "Saving…" : "Save New Version"}</Button></DialogFooter></DialogContent></Dialog><TrafficDistributionDialog open={trafficOpen} onOpenChange={setTrafficOpen} assistantId={assistantId} versions={versions} />{showChat ? <AssistantChatPanel assistant={{ ...values, id: assistantId }} open={showChat} onClose={() => setShowChat(false)} /> : null}<AssistantPhoneWidget assistantId={assistantId} assistantName={values.name} open={showPhone} onClose={() => setShowPhone(false)} /></AdminPageShell>;
}
