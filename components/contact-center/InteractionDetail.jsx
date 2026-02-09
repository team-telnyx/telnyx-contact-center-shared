"use client";

import { useState, useEffect } from "react";
import { AgentAssist } from "./AgentAssist";
import { AgentAssistWorkflow } from "./AgentAssistWorkflow";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClipboardList, BookOpen, Sparkles } from "lucide-react";
import useWorkflowStore from "@/lib/stores/workflow-store";

/**
 * InteractionDetail Component
 * 
 * Displays Agent Assist based on configuration:
 * - KB Articles mode: shows knowledge base article suggestions
 * - Workflows mode: shows guided workflow checklist
 * 
 * Configuration is read from:
 * 1. interaction.metadata.agent_assist_config (set by call flow node)
 * 2. Default: KB Articles mode
 */
export function InteractionDetail({ interaction }) {
  const [assistConfig, setAssistConfig] = useState(null);
  const session = useWorkflowStore((state) => state.session);

  // Determine assist configuration from interaction metadata
  useEffect(() => {
    if (!interaction) {
      setAssistConfig(null);
      return;
    }

    // Check interaction metadata for agent_assist_config (set by call flow node)
    const metadataConfig = interaction.metadata?.agent_assist_config;
    if (metadataConfig) {
      setAssistConfig(metadataConfig);
      return;
    }
    // Default: KB Articles mode
    setAssistConfig({
      enabled: true,
      assist_type: "kb_articles",
      kb_auto_suggest: true,
      kb_max_suggestions: 3,
    });
  }, [interaction]);

  if (!interaction) {
    return (
      <div className="flex items-center justify-center flex-1 text-muted-foreground">
        <p>Select an interaction to view details</p>
      </div>
    );
  }

  // If agent assist is disabled
  if (assistConfig && assistConfig.enabled === false) {
    return (
      <div className="flex items-center justify-center flex-1 text-muted-foreground">
        <div className="text-center">
          <Sparkles className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p>Agent Assist is disabled for this call</p>
        </div>
      </div>
    );
  }

  const assistType = assistConfig?.assist_type || "kb_articles";
  const workflowId = assistConfig?.workflow_id;

  // If workflows mode with a specific workflow
  if (assistType === "workflows" && workflowId) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <Tabs defaultValue="workflow" className="h-full flex flex-col">
          <TabsList className="w-full justify-start bg-muted/50 px-2 shrink-0">
            <TabsTrigger value="workflow" className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              Workflow
              {session && (
                <span className="text-xs bg-purple-500/20 text-purple-500 px-1.5 py-0.5 rounded">
                  {session.status === "completed" ? "✓" : "Active"}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="kb" className="flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              KB Articles
            </TabsTrigger>
          </TabsList>

          <TabsContent value="workflow" className="flex-1 mt-3 overflow-hidden">
            <AgentAssistWorkflow 
              interactionId={interaction.id} 
              workflowId={workflowId}
            />
          </TabsContent>

          <TabsContent value="kb" className="flex-1 mt-3 overflow-hidden">
            <AgentAssist 
              interactionId={interaction.id} 
              interaction={interaction}
              config={assistConfig}
            />
          </TabsContent>
        </Tabs>
      </div>
    );
  }

  // KB Articles mode (default)
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <AgentAssist 
        interactionId={interaction.id} 
        interaction={interaction}
        config={assistConfig}
      />
    </div>
  );
}
