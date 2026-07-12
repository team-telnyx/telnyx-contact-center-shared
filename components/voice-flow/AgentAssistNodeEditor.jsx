"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { VariableInput } from "./VariableInput";
import { FORM_COMPONENT_REGISTRY, normalizeFormDefinition } from "@/lib/forms/form-schema";
import { Separator } from "@/components/ui/separator";
import {
  IconRobot,
  IconGitBranch,
  IconBook,
  IconCalendar,
  IconCalendarTime,
  IconClock,
  IconFileText,
  IconWorld,
} from "@tabler/icons-react";

function dateInputType(mode) {
  return mode === "time" ? "time" : mode === "datetime" || mode === "datetime-local" ? "datetime-local" : "date";
}

function DateTimeStaticValueInput({ field, value, onChange }) {
  const inputRef = useRef(null);
  const inputType = dateInputType(field.props?.mode);
  const PickerIcon = inputType === "time" ? IconClock : inputType === "date" ? IconCalendar : IconCalendarTime;
  const label = inputType === "time" ? "Open time picker" : inputType === "date" ? "Open date picker" : "Open date and time picker";

  function openPicker() {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
      } catch {
        // Browser may reject showPicker when it is not triggered by direct user activation.
      }
    }
  }

  return (
    <div className="relative min-w-0">
      <Input
        ref={inputRef}
        type={inputType}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder || "Value to prefill"}
        className="h-9 pr-10 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-100 dark:[&::-webkit-calendar-picker-indicator]:invert"
      />
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={openPicker}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PickerIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function AgentAssistNodeEditor({
  config = {},
  onChange,
  experimentalFeaturesEnabled = false,
  availableVariables = [],
}) {
  const [workflows, setWorkflows] = useState([]);
  const [kbCategories, setKbCategories] = useState([]);
  const [forms, setForms] = useState([]);
  const [webPages, setWebPages] = useState([]);
  const [workflowDetails, setWorkflowDetails] = useState(null);
  const [loadingWorkflowDetails, setLoadingWorkflowDetails] = useState(false);
  const [loadingWorkflows, setLoadingWorkflows] = useState(true);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [loadingForms, setLoadingForms] = useState(true);
  const [loadingWebPages, setLoadingWebPages] = useState(true);

  const assistType = config.assist_type || "kb_articles";
  const enabled = config.enabled !== false;

  // Load workflows on mount
  useEffect(() => {
    async function loadWorkflows() {
      try {
        const res = await fetch("/api/admin/workflows?isActive=true", {
          cache: "no-store",
        });
        const data = await res.json();
        if (data.ok && data.workflows) {
          setWorkflows(data.workflows);
        }
      } catch (err) {
        console.error("Failed to load workflows:", err);
      } finally {
        setLoadingWorkflows(false);
      }
    }
    loadWorkflows();
  }, []);

  // Load workflow details when a workflow is selected so slot names can be mapped.
  useEffect(() => {
    if (assistType !== "workflows" || !config.workflow_id) {
      setWorkflowDetails(null);
      setLoadingWorkflowDetails(false);
      return;
    }

    let cancelled = false;
    async function loadWorkflowDetails() {
      setLoadingWorkflowDetails(true);
      try {
        const res = await fetch(`/api/admin/workflows/${encodeURIComponent(config.workflow_id)}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!cancelled) {
          setWorkflowDetails(data.ok ? data.workflow : null);
        }
      } catch (err) {
        console.error("Failed to load workflow details:", err);
        if (!cancelled) setWorkflowDetails(null);
      } finally {
        if (!cancelled) setLoadingWorkflowDetails(false);
      }
    }
    loadWorkflowDetails();
    return () => {
      cancelled = true;
    };
  }, [assistType, config.workflow_id]);

  // Load forms on mount
  useEffect(() => {
    async function loadForms() {
      try {
        const res = await fetch("/api/admin/forms?status=published", { cache: "no-store" });
        const data = await res.json();
        if (data.ok && data.forms) setForms(data.forms);
      } catch (err) {
        console.error("Failed to load forms:", err);
      } finally {
        setLoadingForms(false);
      }
    }
    loadForms();
  }, []);

  // Load active web pages on mount
  useEffect(() => {
    async function loadWebPages() {
      try {
        const res = await fetch("/api/admin/web-pages", { cache: "no-store" });
        const data = await res.json();
        if (data.ok && data.pages) setWebPages(data.pages.filter((page) => page.is_active !== false));
      } catch (err) {
        console.error("Failed to load web pages:", err);
      } finally {
        setLoadingWebPages(false);
      }
    }
    loadWebPages();
  }, []);

  // Normalize legacy Web Pages multi-select config to the canonical single web_page_id.
  useEffect(() => {
    if (assistType !== "web_pages" && assistType !== "web_page") return;
    if (!Array.isArray(config.web_page_ids) || config.web_page_ids.length === 0) return;
    const firstLegacyWebPageId = config.web_page_id || config.web_page_ids.find(Boolean) || "";
    const { web_page_ids: _legacyWebPageIds, ...nextConfig } = config;
    onChange({
      ...nextConfig,
      web_page_id: firstLegacyWebPageId,
    });
  }, [assistType, config, onChange]);

  // Load KB categories on mount
  useEffect(() => {
    async function loadCategories() {
      try {
        const res = await fetch("/api/kb-articles/categories", {
          cache: "no-store",
        });
        const data = await res.json();
        if (data.ok && data.categories) {
          setKbCategories(data.categories);
        }
      } catch (err) {
        console.error("Failed to load KB categories:", err);
      } finally {
        setLoadingCategories(false);
      }
    }
    loadCategories();
  }, []);

  function handleChange(key, value) {
    onChange({
      ...config,
      [key]: value,
    });
  }

  function getSelectedWebPageId() {
    if (config.web_page_id) return config.web_page_id;
    if (Array.isArray(config.web_page_ids)) {
      return config.web_page_ids.find(Boolean) || "";
    }
    return "";
  }

  function handleWebPageSelect(pageId) {
    const { web_page_ids: _legacyWebPageIds, ...nextConfig } = config;
    onChange({
      ...nextConfig,
      web_page_id: pageId === "all" ? "" : pageId,
    });
  }

  const selectedWorkflow = workflows.find((w) => w.id === config.workflow_id);
  const selectedWorkflowSlots = useMemo(() => {
    const stages = workflowDetails?.stages || [];
    return stages.flatMap((stage) =>
      (stage.items || [])
        .filter((item) => item.type === "slot" && item.slot_name)
        .map((item) => ({ ...item, stageName: stage.name })),
    );
  }, [workflowDetails]);
  const selectedWebPageId = getSelectedWebPageId();
  const selectedWebPage = webPages.find((page) => page.id === selectedWebPageId);
  const selectedForm = forms.find((form) => form.id === config.form_id);
  const selectedFormFields = useMemo(() => {
    if (!selectedForm) return [];
    const normalized = normalizeFormDefinition(selectedForm);
    return (normalized.schema?.fields || []).filter((field) =>
      FORM_COMPONENT_REGISTRY[field.type]?.data && field.variableName,
    );
  }, [selectedForm]);
  const formDataConfig = config.form_data && typeof config.form_data === "object" ? config.form_data : {};
  const workflowDataConfig = config.workflow_data && typeof config.workflow_data === "object" ? config.workflow_data : {};

  function updateFormDataField(variableName, patch) {
    const current = formDataConfig[variableName] || { source: "none", value: "" };
    const nextEntry = { ...current, ...patch };
    const nextFormData = { ...formDataConfig };
    if (!nextEntry.source || nextEntry.source === "none") delete nextFormData[variableName];
    else nextFormData[variableName] = nextEntry;
    onChange({ ...config, form_data: nextFormData });
  }

  function updateWorkflowDataField(slotName, patch) {
    const current = workflowDataConfig[slotName] || { source: "none", value: "" };
    const nextEntry = { ...current, ...patch };
    const nextWorkflowData = { ...workflowDataConfig };
    if (!nextEntry.source || nextEntry.source === "none") delete nextWorkflowData[slotName];
    else nextWorkflowData[slotName] = nextEntry;
    onChange({ ...config, workflow_data: nextWorkflowData });
  }

  function handleWorkflowSelect(value) {
    const workflowId = value === "none" ? "" : value;
    const nextConfig = { ...config, workflow_id: workflowId };
    if (!workflowId) nextConfig.workflow_data = {};
    onChange(nextConfig);
  }

  function handleFormSelect(value) {
    const formId = value === "queue" ? "" : value;
    const nextConfig = { ...config, form_id: formId };
    if (!formId) nextConfig.form_data = {};
    onChange(nextConfig);
  }

  const selectTriggerClassName = "w-full max-w-full min-w-0 overflow-hidden [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate";
  const selectContentClassName = "w-[var(--radix-select-trigger-width)] max-w-[min(var(--radix-select-trigger-width),calc(100vw-2rem))] overflow-x-hidden";
  const selectItemClassName = "max-w-full min-w-0 [&>span:last-child]:min-w-0 [&>span:last-child]:max-w-full [&>span:last-child]:truncate";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <IconRobot className="h-4 w-4" />
        <span>Configure Agent Assist settings for this call flow</span>
      </div>

      {/* Enable/Disable */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label>Enable Agent Assist</Label>
          <p className="text-xs text-muted-foreground">
            Turn on AI-powered agent assistance for calls in this flow
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => handleChange("enabled", checked)}
        />
      </div>

      <Separator />

      {/* Assist Type Selection */}
      <div className="space-y-3">
        <Label>Assist Type</Label>
        <p className="text-xs text-muted-foreground">
          Choose how Agent Assist should help agents during calls
        </p>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => handleChange("assist_type", "kb_articles")}
            className={`p-4 rounded-lg border-2 text-left transition-all ${
              assistType === "kb_articles"
                ? "border-violet-500 bg-violet-500/10"
                : "border-border hover:border-muted-foreground/50"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <IconBook className={`h-5 w-5 ${assistType === "kb_articles" ? "text-violet-500" : "text-muted-foreground"}`} />
              <span className="font-medium">KB Articles</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Suggest relevant knowledge base articles based on conversation context
            </p>
          </button>
          <button
            type="button"
            onClick={() => handleChange("assist_type", "workflows")}
            className={`p-4 rounded-lg border-2 text-left transition-all ${
              assistType === "workflows"
                ? "border-violet-500 bg-violet-500/10"
                : "border-border hover:border-muted-foreground/50"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <IconGitBranch className={`h-5 w-5 ${assistType === "workflows" ? "text-violet-500" : "text-muted-foreground"}`} />
              <span className="font-medium">Workflows</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Guide agents through structured call workflows with stages and items
            </p>
          </button>
          <button
            type="button"
            onClick={() => handleChange("assist_type", "forms")}
            className={`p-4 rounded-lg border-2 text-left transition-all ${
              assistType === "forms"
                ? "border-violet-500 bg-violet-500/10"
                : "border-border hover:border-muted-foreground/50"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <IconFileText className={`h-5 w-5 ${assistType === "forms" ? "text-violet-500" : "text-muted-foreground"}`} />
              <span className="font-medium">Forms</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Auto-open custom queue forms in the agent desktop
            </p>
          </button>
          <button
            type="button"
            onClick={() => handleChange("assist_type", "web_pages")}
            className={`p-4 rounded-lg border-2 text-left transition-all ${
              assistType === "web_pages"
                ? "border-violet-500 bg-violet-500/10"
                : "border-border hover:border-muted-foreground/50"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <IconWorld className={`h-5 w-5 ${assistType === "web_pages" ? "text-violet-500" : "text-muted-foreground"}`} />
              <span className="font-medium">Web Pages</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Open selected admin web pages in the agent desktop
            </p>
          </button>
        </div>
      </div>

      <Separator />

      {/* KB Articles Options */}
      {assistType === "kb_articles" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 text-sm font-medium">
            <IconBook className="h-4 w-4 text-violet-500" />
            KB Articles Settings
          </div>

          {/* KB Category */}
          <div className="space-y-2">
            <Label>KB Category (Optional)</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Filter suggestions to a specific category
            </p>
            {loadingCategories ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <Select
                value={config.kb_category || "all"}
                onValueChange={(value) => handleChange("kb_category", value === "all" ? "" : value)}
              >
                <SelectTrigger className={selectTriggerClassName}>
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent className={selectContentClassName}>
                  <SelectItem value="all" className={selectItemClassName}>All categories</SelectItem>
                  {kbCategories.map((cat) => (
                    <SelectItem key={cat.id || cat.name || cat} value={cat.id || cat.name || cat} className={selectItemClassName}>
                      {cat.name || cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Auto-suggest */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-suggest Articles</Label>
              <p className="text-xs text-muted-foreground">
                Automatically suggest relevant articles based on conversation
              </p>
            </div>
            <Switch
              checked={config.kb_auto_suggest !== false}
              onCheckedChange={(checked) => handleChange("kb_auto_suggest", checked)}
            />
          </div>

          {/* Max Suggestions */}
          <div className="space-y-2">
            <Label>Max Suggestions</Label>
            <p className="text-xs text-muted-foreground">
              Maximum number of articles to suggest at once
            </p>
            <Input
              type="number"
              min={1}
              max={10}
              value={config.kb_max_suggestions || 3}
              onChange={(e) => handleChange("kb_max_suggestions", parseInt(e.target.value) || 3)}
              className="w-24"
            />
          </div>
        </div>
      )}



      {/* Forms Options */}
      {assistType === "forms" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 text-sm font-medium">
            <IconFileText className="h-4 w-4 text-violet-500" />
            Forms Settings
          </div>
          <div className="space-y-2">
            <Label>Primary form</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Select one published form; queue-assigned auto-open forms can also appear.
            </p>
            {loadingForms ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <Select
                value={config.form_id || "queue"}
                onValueChange={handleFormSelect}
              >
                <SelectTrigger className={selectTriggerClassName}>
                  <SelectValue placeholder="Use queue-assigned forms" />
                </SelectTrigger>
                <SelectContent className={selectContentClassName}>
                  <SelectItem value="queue" className={selectItemClassName}>Use queue-assigned forms</SelectItem>
                  {forms.map((form) => (
                    <SelectItem key={form.id} value={form.id} className={selectItemClassName}>{form.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {selectedForm ? (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
              <div>
                <Label>Form data prefill</Label>
                <p className="text-xs text-muted-foreground">
                  Optional values to pass into the selected Agent Assist form. Values are keyed by each field variable name.
                </p>
              </div>
              {selectedFormFields.length ? (
                <div className="space-y-3">
                  {selectedFormFields.map((field) => {
                    const entry = formDataConfig[field.variableName] || { source: "none", value: "" };
                    const source = entry.source || "none";
                    return (
                      <div key={field.id} className="space-y-2 rounded-md border bg-background p-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate text-sm font-medium">{field.label || field.id}</span>
                          <Badge variant="outline" className="font-mono text-[10px]">{field.variableName}</Badge>
                          <Badge variant="secondary" className="text-[10px]">{field.type}</Badge>
                        </div>
                        <div className="flex min-w-0 flex-col gap-1.5 md:flex-row md:items-start">
                          <Select value={source} onValueChange={(value) => updateFormDataField(field.variableName, { source: value, value: value === "none" ? "" : entry.value || "" })}>
                            <SelectTrigger className="h-9 w-full md:w-[108px] md:shrink-0"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              <SelectItem value="static">Static</SelectItem>
                              <SelectItem value="variable">Variable</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="min-w-0 flex-1">
                            {source === "variable" ? (
                              <VariableInput
                                value={entry.value || ""}
                                onChange={(value) => updateFormDataField(field.variableName, { source: "variable", value })}
                                availableVariables={availableVariables}
                                placeholder="{{customer_name}} or {{client_state.customer.name}}"
                                className="h-9"
                              />
                            ) : source === "static" ? (
                              field.type === "switch" ? (
                                <div className="flex h-9 items-center gap-2">
                                  <Switch checked={entry.value === true || entry.value === "true"} onCheckedChange={(checked) => updateFormDataField(field.variableName, { source: "static", value: checked })} />
                                  <span className="text-xs text-muted-foreground">{entry.value === true || entry.value === "true" ? "true" : "false"}</span>
                                </div>
                              ) : (
                                field.type === "datetime" ? (
                                  <DateTimeStaticValueInput
                                    field={field}
                                    value={entry.value}
                                    onChange={(value) => updateFormDataField(field.variableName, { source: "static", value })}
                                  />
                                ) : (
                                  <Input
                                    type={field.type === "slider" ? "number" : "text"}
                                    value={entry.value ?? ""}
                                    onChange={(e) => updateFormDataField(field.variableName, { source: "static", value: e.target.value })}
                                    placeholder="Value to prefill"
                                    className="h-9"
                                  />
                                )
                              )
                            ) : (
                              <div className="flex h-9 items-center text-xs text-muted-foreground">Leave blank</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  This form has no data fields with variable names.
                </div>
              )}
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-open forms</Label>
              <p className="text-xs text-muted-foreground">
                Open selected and queue-assigned forms when the interaction appears.
              </p>
            </div>
            <Switch
              checked={config.auto_open_forms !== false}
              onCheckedChange={(checked) => handleChange("auto_open_forms", checked)}
            />
          </div>
        </div>
      )}

      {/* Web Pages Options */}
      {assistType === "web_pages" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 text-sm font-medium">
            <IconWorld className="h-4 w-4 text-violet-500" />
            Web Pages Settings
          </div>
          <div className="space-y-2">
            <Label>Web page</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Select one active web page to show for this interaction. Leave empty to show all active web pages.
            </p>
            {loadingWebPages ? (
              <Skeleton className="h-10 w-full" />
            ) : webPages.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No active web pages configured in Admin → Web Pages.
              </div>
            ) : (
              <>
                <Select
                  value={selectedWebPageId || "all"}
                  onValueChange={handleWebPageSelect}
                >
                  <SelectTrigger className={selectTriggerClassName}>
                    <SelectValue placeholder="All active web pages" />
                  </SelectTrigger>
                  <SelectContent className={selectContentClassName}>
                    <SelectItem value="all" className={selectItemClassName}>
                      <span className="text-muted-foreground">All active web pages</span>
                    </SelectItem>
                    {webPages.map((page) => (
                      <SelectItem key={page.id} value={page.id} className={selectItemClassName}>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate">{page.name}</span>
                          {page.icon && <Badge variant="outline" className="shrink-0 text-[10px]">{page.icon}</Badge>}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedWebPage && (
                  <div className="mt-2 rounded-md bg-muted p-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{selectedWebPage.name}</span>
                      {selectedWebPage.icon && <Badge variant="outline" className="shrink-0 text-[10px]">{selectedWebPage.icon}</Badge>}
                    </div>
                    {selectedWebPage.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{selectedWebPage.description}</p>
                    )}
                    <p className="mt-1 truncate text-xs text-muted-foreground">{selectedWebPage.url}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Workflow Options */}
      {assistType === "workflows" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 text-sm font-medium">
            <IconGitBranch className="h-4 w-4 text-violet-500" />
            Workflow Settings
          </div>

          {/* Workflow Selection */}
          <div className="space-y-2">
            <Label>Workflow</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Select a workflow to guide agents through this call
            </p>
            {loadingWorkflows ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <Select
                value={config.workflow_id || "none"}
                onValueChange={handleWorkflowSelect}
              >
                <SelectTrigger className={selectTriggerClassName}>
                  <SelectValue placeholder="Select a workflow..." />
                </SelectTrigger>
                <SelectContent className={selectContentClassName}>
                  <SelectItem value="none" className={selectItemClassName}>
                    <span className="text-muted-foreground">No workflow</span>
                  </SelectItem>
                  {workflows.map((workflow) => (
                    <SelectItem key={workflow.id} value={workflow.id} className={selectItemClassName}>
                      <div className="flex min-w-0 items-center gap-2">
                        <IconGitBranch className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 truncate">{workflow.name}</span>
                        {workflow.category && (
                          <Badge variant="secondary" className="ml-1 shrink-0 text-xs">
                            {workflow.category}
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selectedWorkflow && (
              <div className="mt-2 rounded-md bg-muted p-3">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{selectedWorkflow.name}</span>
                  <div className="flex shrink-0 gap-2">
                    <Badge variant="outline">{selectedWorkflow.stages_count || 0} stages</Badge>
                    <Badge variant="outline">{selectedWorkflow.items_count || 0} items</Badge>
                  </div>
                </div>
                {selectedWorkflow.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {selectedWorkflow.description}
                  </p>
                )}
              </div>
            )}
          </div>

          {selectedWorkflow && (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
              <div>
                <Label>Workflow data prefill</Label>
                <p className="text-xs text-muted-foreground">
                  Optional values to pass from call flow client state into matching workflow slot names. Values are stored under <span className="font-mono">workflow_data</span> and only slots defined by this workflow are applied.
                </p>
              </div>
              {loadingWorkflowDetails ? (
                <Skeleton className="h-20 w-full" />
              ) : selectedWorkflowSlots.length ? (
                <div className="space-y-3">
                  {selectedWorkflowSlots.map((slot) => {
                    const entry = workflowDataConfig[slot.slot_name] || { source: "none", value: "" };
                    const source = entry.source || "none";
                    return (
                      <div key={slot.id} className="space-y-2 rounded-md border bg-background p-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate text-sm font-medium">{slot.label || slot.slot_name}</span>
                          <Badge variant="outline" className="font-mono text-[10px]">{slot.slot_name}</Badge>
                          <Badge variant="secondary" className="text-[10px]">{slot.slot_type || "text"}</Badge>
                          {slot.stageName && <Badge variant="outline" className="text-[10px]">{slot.stageName}</Badge>}
                        </div>
                        <div className="flex min-w-0 flex-col gap-1.5 md:flex-row md:items-start">
                          <Select value={source} onValueChange={(value) => updateWorkflowDataField(slot.slot_name, { source: value, value: value === "none" ? "" : entry.value || "" })}>
                            <SelectTrigger className="h-9 w-full md:w-[108px] md:shrink-0"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              <SelectItem value="static">Static</SelectItem>
                              <SelectItem value="variable">Variable</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="min-w-0 flex-1">
                            {source === "variable" ? (
                              <VariableInput
                                value={entry.value || ""}
                                onChange={(value) => updateWorkflowDataField(slot.slot_name, { source: "variable", value })}
                                availableVariables={availableVariables}
                                placeholder="{{customer_name}} or {{client_state.customer.name}}"
                                className="h-9"
                              />
                            ) : source === "static" ? (
                              <Input
                                type={slot.slot_type === "number" ? "number" : "text"}
                                value={entry.value ?? ""}
                                onChange={(e) => updateWorkflowDataField(slot.slot_name, { source: "static", value: e.target.value })}
                                placeholder="Value to prefill"
                                className="h-9"
                              />
                            ) : (
                              <div className="flex h-9 items-center text-xs text-muted-foreground">Leave blank</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  This workflow has no slot items with slot names.
                </div>
              )}
            </div>
          )}

          {/* Auto-start */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-start on Answer</Label>
              <p className="text-xs text-muted-foreground">
                Automatically start workflow tracking when call is answered
              </p>
            </div>
            <Switch
              checked={config.auto_start !== false}
              onCheckedChange={(checked) => handleChange("auto_start", checked)}
            />
          </div>

          {/* Show Suggestions */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Show AI Suggestions</Label>
              <p className="text-xs text-muted-foreground">
                Display AI-powered suggestions to agents during the call
              </p>
            </div>
            <Switch
              checked={config.show_suggestions !== false}
              onCheckedChange={(checked) => handleChange("show_suggestions", checked)}
            />
          </div>

          {/* Show expanded stages */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Show expanded stages</Label>
              <p className="text-xs text-muted-foreground">
                Open all workflow stages in Agent Assist and scroll to items as they update
              </p>
            </div>
            <Switch
              checked={config.show_expanded_stages === true}
              onCheckedChange={(checked) => handleChange("show_expanded_stages", checked)}
            />
          </div>

          {/* Auto-detect Completion */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-detect Item Completion</Label>
              <p className="text-xs text-muted-foreground">
                Automatically mark workflow items as complete based on conversation
              </p>
            </div>
            <Switch
              checked={config.auto_detect_completion !== false}
              onCheckedChange={(checked) => handleChange("auto_detect_completion", checked)}
            />
          </div>

          {/* Intent Recognition */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Enable Intent Recognition</Label>
              <p className="text-xs text-muted-foreground">
                Detect intent for finalized transcription messages
              </p>
            </div>
            <Switch
              checked={config.enable_intent_recognition === true}
              onCheckedChange={(checked) => handleChange("enable_intent_recognition", checked)}
            />
          </div>

          {/* Sentiment Analysis */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Enable Sentiment Analysis</Label>
              <p className="text-xs text-muted-foreground">
                Analyze sentiment for finalized transcription messages
              </p>
            </div>
            <Switch
              checked={config.enable_sentiment_analysis === true}
              onCheckedChange={(checked) => handleChange("enable_sentiment_analysis", checked)}
            />
          </div>

          {/* STT Confidence display */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Enable STT Confidence</Label>
              <p className="text-xs text-muted-foreground">
                Show speech-to-text confidence badges in the agent UI
              </p>
            </div>
            <Switch
              checked={config.enable_stt_confidence !== false}
              onCheckedChange={(checked) => handleChange("enable_stt_confidence", checked)}
            />
          </div>

          {/* LLM Confidence display */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Enable LLM Confidence</Label>
              <p className="text-xs text-muted-foreground">
                Show LLM extraction confidence badges in the agent UI
              </p>
            </div>
            <Switch
              checked={config.enable_llm_confidence !== false}
              onCheckedChange={(checked) => handleChange("enable_llm_confidence", checked)}
            />
          </div>

          {/* Online Translation — experimental, gated per user account */}
          {experimentalFeaturesEnabled && (
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Enable online translation</Label>
                <p className="text-xs text-muted-foreground">
                  Translate live transcriptions between caller and agent
                </p>
              </div>
              <Switch
                checked={config.enable_translation === true}
                onCheckedChange={(checked) => handleChange("enable_translation", checked)}
              />
            </div>
          )}

          {/* Auto-send TTS — experimental, gated per user account */}
          {experimentalFeaturesEnabled && (
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Auto send response</Label>
                <p className="text-xs text-muted-foreground">
                  Automatically speak translated text in the opposite call leg
                </p>
              </div>
              <Switch
                checked={config.auto_send_response === true}
                onCheckedChange={(checked) => handleChange("auto_send_response", checked)}
                disabled={!config.enable_translation}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
