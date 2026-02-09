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
import { IconRobot, IconGitBranch } from "@tabler/icons-react";

export default function AgentAssistNodeEditor({
  node,
  updateNodeData,
  nodes,
  edges,
}) {
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const config = node.data?.config || {};

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
        setLoading(false);
      }
    }
    loadWorkflows();
  }, []);

  function handleChange(key, value) {
    updateNodeData(node.id, {
      ...node.data,
      config: {
        ...config,
        [key]: value,
      },
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
          checked={config.enabled !== false}
          onCheckedChange={(checked) => handleChange("enabled", checked)}
        />
      </div>

      {/* Workflow Selection */}
      <div className="space-y-2">
        <Label>Workflow</Label>
        <p className="text-xs text-muted-foreground mb-2">
          Select a workflow to guide agents through this call
        </p>
        {loading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <Select
            value={config.workflow_id || ""}
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
  );
}
