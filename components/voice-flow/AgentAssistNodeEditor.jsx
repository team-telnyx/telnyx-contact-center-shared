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
import {
  IconRobot,
  IconGitBranch,
  IconBook,
} from "@tabler/icons-react";

export default function AgentAssistNodeEditor({
  config = {},
  onChange,
}) {
  const [workflows, setWorkflows] = useState([]);
  const [kbCategories, setKbCategories] = useState([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(true);
  const [loadingCategories, setLoadingCategories] = useState(true);

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
        </div>
      )}
    </div>
  );
}
