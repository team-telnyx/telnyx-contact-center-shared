"use client";

import { validateConversationFlow } from "@/lib/ai/assistant-conversation-workflow.mjs";
import { assistantSaveErrorMessage, assistantVerificationMessage } from "@/lib/ai/assistant-save-feedback.mjs";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  IconActivity,
  IconCheck,
  IconChartBar,
  IconUserCircle,
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
import { validateAssistantDraftChanges } from "@/lib/ai/assistant-contract.mjs";
import { assistantForEditor, payloadForSave, modelConfigurationErrors } from "@/lib/ai/assistant-draft.mjs";
import { assertVisionCapability } from "@/lib/ai/vision-capabilities.mjs";
import { AssistantCatalogProvider } from "./AssistantModelConfiguration";
import AssistantSettingsSection from "./AssistantSettingsSection";
import { AssistantJsonDraftContext } from "./AssistantSchemaFields";
import AssistantSettingsSearch from "./AssistantSettingsSearch";
import AssistantChangeReview from "./AssistantChangeReview";
import AgentSettingsPanel from "@/components/assistants/AgentSettingsPanel";
import AssistantChatPanel from "@/components/assistants/AssistantChatPanel";
import AssistantPhoneWidget from "@/components/assistants/AssistantPhoneWidget";
import AssistantConversationsPanel from "@/components/assistants/AssistantConversationsPanel";
import AssistantDashboardTab from "@/components/assistants/AssistantDashboardTab";
import TrafficDistributionDialog from "@/components/assistants/TrafficDistributionDialog";
import VoiceTab from "@/components/assistants/VoiceTab";
import AssistantAvatarSettings from "@/components/assistants/AssistantAvatarSettings";
import AssistantWorkflowTab from "@/components/assistants/AssistantWorkflowTab";
import IntegrationsTab from "@/components/assistants/IntegrationsTab";
import InsightsTab from "@/components/assistants/InsightsTab";
import AssistantCallingSettings from "@/components/assistants/AssistantCallingSettings";
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
  { id: "avatar", label: "Avatar", icon: IconUserCircle, description: "Avatar appearance and voice pairing" },
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

function AssistantIdBadge({ assistantId }) {
  const tUi = useUiText();
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(assistantId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return <Badge variant="outline" className="gap-2 py-1 pl-2.5 pr-1 font-mono text-xs"><span>{assistantId}</span><button type="button" onClick={copy} className="rounded p-1 hover:bg-muted" aria-label={tUi("Copy assistant ID")}>{copied ? <IconCheck className="size-3.5 text-emerald-500" /> : <IconCopy className="size-3.5" />}</button></Badge>;
}

function SectionCard({ title, description, children, className = "" }) {
  return <Card className={className}><CardHeader className="pb-3"><CardTitle className="text-lg">{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader><CardContent className="space-y-5">{children}</CardContent></Card>;
}

function FixedRailCard({ children, scroll = true }) {
  return <Card className="flex h-full min-h-0 w-full flex-col overflow-hidden"><CardContent className="h-full min-h-0 flex-1 p-4"><div className={scroll ? "h-full min-h-0 overflow-y-auto pr-1" : "h-full min-h-0 overflow-hidden"}>{children}</div></CardContent></Card>;
}

function ConversationsPanel({ assistantId, compact = false }) {
  const tUi = useUiText();
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

  if (!assistantId) return <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">{tUi("Save the assistant to view conversations.")}</div>;
  if (loading) return <div className="space-y-2">{Array.from({ length: compact ? 3 : 6 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>;
  const displayed = compact ? items.slice(0, 5) : items;
  return <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>{tUi("Name")}</TableHead><TableHead>{tUi("Channel")}</TableHead><TableHead>{tUi("Created")}</TableHead><TableHead>{tUi("ID")}</TableHead></TableRow></TableHeader><TableBody>{displayed.map((conversation) => <TableRow key={conversation.id}><TableCell>{conversation.name || tUi("Conversation")}</TableCell><TableCell>{conversation.channel || conversation.metadata?.channel || "—"}</TableCell><TableCell>{conversation.created_at ? new Date(conversation.created_at).toLocaleString(tUi.locale) : "—"}</TableCell><TableCell className="max-w-64 truncate font-mono text-xs">{conversation.id}</TableCell></TableRow>)}{!displayed.length && <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">{tUi("No conversations found for this assistant.")}</TableCell></TableRow>}</TableBody></Table></div>;
}

export default function AssistantEditor({ mode, assistantId: initialAssistantId = "" }) {
  const tUi = useUiText();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isCreate = mode === "create";
  const skipLeaveGuardRef = useRef(false);
  const [assistantId, setAssistantId] = useState(initialAssistantId);
  const [values, setValues] = useState(() => assistantForEditor());
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshot(assistantForEditor()));
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
  const [jsonDrafts, setJsonDrafts] = useState({});
  const [sectionTabs, setSectionTabs] = useState({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState(null);
  const localTabProps = (section, fallback) => ({ localTab: sectionTabs[section] || fallback, onLocalTabChange: tab => setSectionTabs(current => ({...current, [section]:tab})) });
  const dirty = snapshot(values) !== savedSnapshot;

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

  /** "Find setting": open the setting's section and tab, then scroll to its field once it is on screen. */
  function findSetting(item) {
    const [section, tab] = item.location;
    selectSection(section);
    if (tab) setSectionTabs(current => ({ ...current, [section]: tab }));
    // A new object each time, so choosing the same result again scrolls to it again.
    setSearchTarget({ path: item.path });
  }
  useEffect(() => {
    if (!searchTarget) return undefined;
    const timer = window.setTimeout(() => {
      const pane = document.querySelector("[data-assistant-content]");
      // The longest matching path wins; between equals the innermost element does (a card around a control
      // carries the same path as a fallback for when the control is not shown).
      const target = [...(pane?.querySelectorAll("[data-setting-path]") || [])]
        .filter(el => searchTarget.path.startsWith(el.dataset.settingPath))
        .reduce((best, el) => (!best || el.dataset.settingPath.length >= best.dataset.settingPath.length ? el : best), null);
      if (target) {
        let parent = target.parentElement;
        while (parent && parent !== pane) { if (parent.tagName === "DETAILS") parent.open = true; parent = parent.parentElement; }
        target.scrollIntoView({ block: "center" });
        target.querySelector("input,select,textarea,button")?.focus();
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [searchTarget, activeSection, sectionTabs]);

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
    const modelErrors = [...modelConfigurationErrors(values), ...modelConfigurationErrors(values.fallback_config, "fallback")];
    if (modelErrors.length) { selectSection("agent"); notify({ title: "Check model configuration", description: modelErrors.join(" "), variant: "warning" }); return; }
    if (Object.values(jsonDrafts).some(draft=>draft.error)) { notify({title:"Fix advanced JSON before saving",variant:"warning"}); return; }
    setSaving(true);
    try {
      const url = isCreate && !assistantId ? "/api/ai/assistants" : `/api/ai/assistants/${encodeURIComponent(assistantId)}`;
      const payload = payloadForSave(values, {patch: Boolean(assistantId)});
      if (payload.conversation_flow) {
        const workflowErrors = validateConversationFlow(payload.conversation_flow, {allowInheritedInstructions: true}, tUi);
        if (workflowErrors.length) {
          selectSection("workflow");
          notify({title: "Check workflow", description: [...workflowErrors.slice(0, 2), ...(workflowErrors.length > 2 ? [tUi("Select the highlighted steps and connections to review the remaining issues.")] : [])].join(" "), variant: "warning", autoCloseMs: 12000});
          return;
        }
      }
      if (values.tools?.some(tool=>tool.type==="vision")) {
        const response = await fetch("/api/ai/models",{cache:"no-store"});
        const catalog = await response.json();
        if (!response.ok) throw new Error("Unable to verify Vision model support. Please retry.");
        assertVisionCapability(values,catalog.models || [],{buffered:true});
      }
      const contractErrors = validateAssistantDraftChanges(payload, values._original);
      if (contractErrors.length) { notify({title: "Check configuration", description: [...new Set(contractErrors.map(error => assistantSaveErrorMessage(error, tUi)))].join(" "), variant: "warning"}); return; }
      if (asNewVersion) {
        payload.promote_to_main = false;
        if (versionName.trim()) payload.version_name = versionName.trim();
      }
      const response = await fetch(url, { method: isCreate && !assistantId ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) throw new Error(data?.error || "Save failed");
      if (data.verification?.status !== "verified") {
        if (data.assistant?.id) {
          setAssistantId(data.assistant.id);
          // Keep the draft mounted, but make refresh reopen the accepted resource.
          if (isCreate && !assistantId) window.history.replaceState(null, "", `/admin/ai-assistants/${encodeURIComponent(data.assistant.id)}?section=${activeSection}`);
        }
        notify({ title: "Save requires attention", description: assistantVerificationMessage(data.verification, tUi), variant: "warning", autoCloseMs: 15000 });
        return;
      }
      let displayedAssistant = data.assistant || payload;
      if (asNewVersion) {
        const mainResponse = await fetch(url, {cache: "no-store"});
        const mainData = await mainResponse.json().catch(() => ({}));
        if (!mainResponse.ok || !mainData.assistant) {
          setNewVersionOpen(false); loadVersions();
          notify({title: "Version saved; reload the main configuration", variant: "warning"});
          return;
        }
        displayedAssistant = mainData.assistant;
      }
      const saved = assistantForEditor(displayedAssistant);
      const nextId = data.assistant?.id || assistantId;
      setValues(saved); setJsonDrafts({}); setSavedSnapshot(snapshot(saved)); setAssistantId(nextId);
      notify({ title: asNewVersion ? "New version saved and verified" : isCreate && !assistantId ? "Assistant created and verified" : "Assistant saved and verified", description: saved.name, variant: "success" });
      if (asNewVersion) { setNewVersionOpen(false); setNewVersionName(""); loadVersions(); }
      if (isCreate && nextId) router.replace(`/admin/ai-assistants/${encodeURIComponent(nextId)}?section=${activeSection}`);
    } catch (error) {
      notify({ title: "Save failed", description: assistantSaveErrorMessage(error, tUi), variant: "error", autoCloseMs: 10000 });
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

  const headerActions = <><AssistantSettingsSearch onSelect={findSetting} /><Button variant="outline" onClick={() => setReviewOpen(true)} disabled={!dirty}>{tUi("Review changes")}</Button><Button variant="outline" onClick={() => assistantId ? setShowChat(true) : notify({ title: "Save the assistant before chatting", variant: "warning" })}><IconMessageCircle className="size-4" />{tUi("Chat")}</Button><Button variant="outline" onClick={callAssistant}><IconPhone className="size-4" />{tUi("Call", undefined, "phone action")}</Button>{assistantId ? <Button variant="outline" onClick={cloneAssistant} disabled={cloning}><IconCopy className="size-4" />{cloning ? tUi("Cloning…") : tUi("Clone")}</Button> : null}{assistantId ? <DropdownMenu onOpenChange={(open) => open && loadVersions()}><DropdownMenuTrigger asChild><Button variant="outline" disabled={promoting}><IconHistory className="size-4" />{tUi("Switch Version")}<IconChevronDown className="size-3" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-64">{versionsLoading ? <DropdownMenuItem disabled>{tUi("Loading versions…")}</DropdownMenuItem> : !versions.length ? <DropdownMenuItem disabled>{tUi("No versions found")}</DropdownMenuItem> : versions.map((version, index) => { const current = version.is_main_version === true || version.is_current === true || version.current === true; const id = version.version_id || version.version_number || version.id || String(index); return <DropdownMenuItem key={id} disabled={current || promoting} onClick={() => !current && promoteVersion(id)} className="flex flex-col items-start"><span>{tUi("Version {value0}", { value0: version.version_number || versions.length - index })}{version.version_name ? ` · ${version.version_name}` : ""}{current ? <span className="ml-2 text-xs text-emerald-500">{tUi("(current)")}</span> : null}</span><span className="text-xs text-muted-foreground">{version.created_at ? new Date(version.created_at).toLocaleString(tUi.locale) : ""}</span></DropdownMenuItem>; })}</DropdownMenuContent></DropdownMenu> : null}{assistantId ? <Button variant="outline" onClick={() => { loadVersions(); setTrafficOpen(true); }}><IconChartBar className="size-4" />{tUi("Traffic %")}</Button> : null}{assistantId ? <Button variant="outline" className="text-destructive" onClick={() => setDeleteOpen(true)}><IconTrash className="size-4" />{tUi("Delete")}</Button> : null}<Button variant="outline" onClick={leaveEditor}>{tUi("Cancel")}</Button><div className="flex"><Button onClick={() => save()} disabled={saving || !dirty} className="rounded-r-none border-r-0">{saving ? tUi("Saving…") : tUi("Save")}</Button><DropdownMenu><DropdownMenuTrigger asChild><Button disabled={saving || !dirty} className="rounded-l-none border-l border-primary-foreground/20 px-2"><IconChevronDown className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => save()}><IconDeviceFloppy className="mr-2 size-4" />{tUi("Save (promote to main)")}</DropdownMenuItem>{assistantId ? <DropdownMenuItem onClick={() => setNewVersionOpen(true)}><IconGitBranch className="mr-2 size-4" />{tUi("Save as New Version")}</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu></div></>;

  function renderSection() {
    if (activeSection === "dashboard") return <AssistantDashboardTab assistantId={assistantId} values={values} summaryState={dashboardSummaryByAssistant[assistantId || "draft"]} onSummaryStateChange={setDashboardSummaryByAssistant} analyticsState={dashboardAnalyticsByAssistant[assistantId || "draft"]} onAnalyticsStateChange={setDashboardAnalyticsByAssistant} />;

    if (activeSection === "agent") return <AgentSettingsPanel assistantId={assistantId} values={values} setValues={setValues} {...localTabProps("agent", "identity")} />;
    if (activeSection === "voice") return <FixedRailCard scroll={false}><AssistantSettingsSection section="voice" {...localTabProps("voice", "voice")} values={values} setValues={setValues}>{tab => <VoiceTab section={tab} values={values} setValues={setValues} />}</AssistantSettingsSection></FixedRailCard>;
    if (activeSection === "avatar") return <FixedRailCard><AssistantAvatarSettings values={values} setValues={setValues} onVoiceSettings={() => { setSectionTabs(current => ({...current, voice: "voice"})); selectSection("voice"); }} /></FixedRailCard>;
    if (activeSection === "workflow") return <FixedRailCard scroll={false}><AssistantWorkflowTab values={values} setValues={setValues} assistantId={assistantId} /></FixedRailCard>;
    if (activeSection === "integrations") return <FixedRailCard scroll={false}><IntegrationsTab values={values} setValues={setValues} assistantId={assistantId} {...localTabProps("integrations", "tools")} /></FixedRailCard>;
    if (activeSection === "insights") return <FixedRailCard scroll={false}><AssistantSettingsSection section="insights" {...localTabProps("insights", "insight")} values={values} setValues={setValues}>{() => <InsightsTab values={values} setValues={setValues} isCreate={isCreate} />}</AssistantSettingsSection></FixedRailCard>;
    if (activeSection === "calling") return <FixedRailCard scroll={false}><AssistantSettingsSection section="calling" {...localTabProps("calling", "connection")} values={values} setValues={setValues}>{tab => tab === "connection" ? <CallingTab connectionOnly values={values} setValues={setValues} /> : <AssistantCallingSettings section={tab} values={values} setValues={setValues}/>}</AssistantSettingsSection></FixedRailCard>;
    if (activeSection === "messaging") return <FixedRailCard scroll={false}><AssistantSettingsSection section="messaging" {...localTabProps("messaging", "routing")} values={values} setValues={setValues}>{()=><MessagingTab values={values} setValues={setValues}/>}</AssistantSettingsSection></FixedRailCard>;
    if (activeSection === "widget") return <FixedRailCard scroll={false}><AssistantSettingsSection section="widget" {...localTabProps("widget", "appearance")} values={values} setValues={setValues}>{tab => <WidgetTab draftMode section={tab} values={values} setValues={setValues} assistantId={assistantId} />}</AssistantSettingsSection></FixedRailCard>;
    if (activeSection === "privacy") return <FixedRailCard scroll={false}><AssistantSettingsSection section="privacy" {...localTabProps("privacy", "retention")} values={values} setValues={setValues}>{() => <PrivacyTab values={values} setValues={setValues} />}</AssistantSettingsSection></FixedRailCard>;

    return <AssistantConversationsPanel assistantId={assistantId} />;
  }

  if (loading) return <AdminPageShell><AdminPageHeader title={tUi("AI Assistant")} icon={IconRobot} /><div className="space-y-3 p-6"><Skeleton className="h-20 w-full" /><Skeleton className="h-[480px] w-full" /></div></AdminPageShell>;

  return <AssistantJsonDraftContext.Provider value={{drafts:jsonDrafts,setDrafts:setJsonDrafts}}><AssistantCatalogProvider><AdminPageShell><AdminPageHeader title={isCreate && !assistantId ? tUi("New AI Assistant") : values.name || tUi("AI Assistant")} icon={IconRobot} badges={<>{assistantId ? <AssistantIdBadge assistantId={assistantId} /> : <Badge variant="secondary">{tUi("Draft")}</Badge>}{dirty ? <Badge className="bg-amber-500 text-black hover:bg-amber-500">{tUi("Unsaved")}</Badge> : <Badge variant="secondary">{tUi("Saved")}</Badge>}</>} actions={headerActions} actionsClassName="ml-auto justify-end" /><main className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3" style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}><SectionRail fixedItems={[EXIT_RAIL_ITEM]} items={RAIL_ITEMS} activeId={activeSection} onSelect={selectSection} ariaLabel={tUi("Assistant configuration sections")} /><section data-assistant-content className="h-full min-h-0 overflow-hidden pr-1">{renderSection()}</section></main><AssistantChangeReview values={values} assistantId={assistantId} open={reviewOpen} onOpenChange={setReviewOpen} /><AlertDialog open={leaveOpen} onOpenChange={(open) => { setLeaveOpen(open); if (!open) setLeaveTarget("/admin/ai-assistants"); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{tUi("Unsaved Changes")}</AlertDialogTitle><AlertDialogDescription>{tUi("You have unsaved changes. Are you sure you want to leave? All unsaved changes will be lost.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{tUi("Cancel")}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmLeave}>{tUi("Leave without saving")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog><AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{tUi("Delete assistant?")}</AlertDialogTitle><AlertDialogDescription>{tUi("This permanently deletes ")}{values.name || assistantId}{tUi(" from Telnyx.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>{tUi("Cancel")}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleting} onClick={remove}>{deleting ? tUi("Deleting…") : tUi("Delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog><Dialog open={newVersionOpen} onOpenChange={setNewVersionOpen}><DialogContent><DialogHeader><DialogTitle>{tUi("Save as New Version")}</DialogTitle><DialogDescription>{tUi("Creates a new version without changing the current live version.")}</DialogDescription></DialogHeader><div className="space-y-2 py-2"><label className="text-sm font-medium">{tUi("Version Name (optional)")}</label><Input maxLength={50} placeholder={tUi("e.g. v2 with updated prompts")} value={newVersionName} onChange={(event) => setNewVersionName(event.target.value)} /></div><DialogFooter><Button variant="outline" onClick={() => { setNewVersionOpen(false); setNewVersionName(""); }} disabled={saving}>{tUi("Cancel")}</Button><Button onClick={() => save({ asNewVersion: true, versionName: newVersionName })} disabled={saving}>{saving ? tUi("Saving…") : tUi("Save New Version")}</Button></DialogFooter></DialogContent></Dialog><TrafficDistributionDialog open={trafficOpen} onOpenChange={setTrafficOpen} assistantId={assistantId} versions={versions} />{showChat ? <AssistantChatPanel assistant={{ ...values, id: assistantId }} open={showChat} onClose={() => setShowChat(false)} /> : null}<AssistantPhoneWidget assistantId={assistantId} assistantName={values.name} open={showPhone} onClose={() => setShowPhone(false)} /></AdminPageShell></AssistantCatalogProvider></AssistantJsonDraftContext.Provider>;
}
