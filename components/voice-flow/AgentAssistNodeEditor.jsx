"use client";

import { useState, useEffect } from "react";
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
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  IconRobot,
  IconGitBranch,
  IconBook,
  IconFileText,
  IconWorld,
} from "@tabler/icons-react";

const EXPERIMENTAL_USER = "leszek@telnyx.com";

export default function AgentAssistNodeEditor({
  config = {},
  onChange,
  currentUserEmail,
}) {
  const isExperimentalUser = currentUserEmail === EXPERIMENTAL_USER;
  const [workflows, setWorkflows] = useState([]);
  const [kbCategories, setKbCategories] = useState([]);
  const [forms, setForms] = useState([]);
  const [webPages, setWebPages] = useState([]);
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

  function getSelectedWebPageIds() {
    return Array.isArray(config.web_page_ids)
      ? config.web_page_ids
      : config.web_page_id
        ? [config.web_page_id]
        : [];
  }

  function handleWebPageToggle(pageId, checked) {
    const currentIds = getSelectedWebPageIds();
    const nextIds = checked
      ? [...new Set([...currentIds, pageId])]
      : currentIds.filter((id) => id !== pageId);
    onChange({
      ...config,
      web_page_ids: nextIds,
      web_page_id: nextIds[0] || "",
    });
  }

  const selectedWorkflow = workflows.find((w) => w.id === config.workflow_id);

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
                <SelectTrigger>
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {kbCategories.map((cat) => (
                    <SelectItem key={cat.id || cat.name || cat} value={cat.id || cat.name || cat}>
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
                onValueChange={(value) => handleChange("form_id", value === "queue" ? "" : value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Use queue-assigned forms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="queue">Use queue-assigned forms</SelectItem>
                  {forms.map((form) => (
                    <SelectItem key={form.id} value={form.id}>{form.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
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
            <Label>Web pages</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Select active web pages to show for this interaction. Leave empty to show all active web pages.
            </p>
            {loadingWebPages ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : webPages.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No active web pages configured in Admin → Web Pages.
              </div>
            ) : (
              <div className="space-y-2 rounded-md border p-2">
                {webPages.map((page) => {
                  const selectedIds = getSelectedWebPageIds();
                  const checked = selectedIds.includes(page.id);
                  return (
                    <label
                      key={page.id}
                      className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => handleWebPageToggle(page.id, value === true)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{page.name}</span>
                          {page.icon && <Badge variant="outline" className="text-[10px]">{page.icon}</Badge>}
                        </div>
                        {page.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">{page.description}</p>
                        )}
                        <p className="text-xs text-muted-foreground truncate">{page.url}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
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
                onValueChange={(value) => handleChange("workflow_id", value === "none" ? "" : value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a workflow..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    <span className="text-muted-foreground">No workflow</span>
                  </SelectItem>
                  {workflows.map((workflow) => (
                    <SelectItem key={workflow.id} value={workflow.id}>
                      <div className="flex items-center gap-2">
                        <IconGitBranch className="h-4 w-4" />
                        <span>{workflow.name}</span>
                        {workflow.category && (
                          <Badge variant="secondary" className="text-xs ml-1">
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
              <div className="mt-2 p-3 bg-muted rounded-md">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{selectedWorkflow.name}</span>
                  <div className="flex gap-2">
                    <Badge variant="outline">{selectedWorkflow.stages_count || 0} stages</Badge>
                    <Badge variant="outline">{selectedWorkflow.items_count || 0} items</Badge>
                  </div>
                </div>
                {selectedWorkflow.description && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedWorkflow.description}
                  </p>
                )}
              </div>
            )}
          </div>

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

          {/* Online Translation — experimental, visible only for leszek@telnyx.com */}
          {isExperimentalUser && (
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

          {/* Auto-send TTS — experimental, visible only for leszek@telnyx.com */}
          {isExperimentalUser && (
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
