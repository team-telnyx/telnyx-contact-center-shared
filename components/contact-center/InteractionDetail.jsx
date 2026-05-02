"use client";

import { useState, useEffect } from "react";
import { AgentAssist } from "./AgentAssist";
import { AgentAssistWorkflow } from "./AgentAssistWorkflow";
import { AgentFormsView } from "./AgentFormsView";
import { Sparkles } from "lucide-react";

/**
 * InteractionDetail Component
 * 
 * Displays Agent Assist based on configuration:
 * - KB Articles mode: shows knowledge base article suggestions
 * - Workflows mode: shows full-width guided workflow (no tabs)
 * - Forms mode: opens selected/queue-assigned forms
 * 
 * Configuration is read from:
 * 1. interaction.metadata.agent_assist_config (set by call flow node)
 * 2. Default: KB Articles mode
 */
export function InteractionDetail({ interaction }) {
  const [assistConfig, setAssistConfig] = useState(null);

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
  const formIds = assistConfig?.form_ids || (assistConfig?.form_id ? [assistConfig.form_id] : []);

  // Workflows mode - full width workflow view without tabs
  if (assistType === "workflows" && workflowId) {
    return (
      <div className="flex flex-col h-full overflow-hidden p-3">
        <AgentAssistWorkflow 
          interactionId={interaction.id} 
          workflowId={workflowId}
          interaction={interaction}
        />
      </div>
    );
  }

  if ((assistType === "forms" || assistType === "form") && (formIds.length > 0 || assistConfig?.auto_open_forms !== false)) {
    return (
      <div className="flex flex-col h-full overflow-hidden p-3">
        <AgentFormsView
          selectedInteraction={interaction}
          formIds={formIds}
          autoOpenOnly={assistConfig?.auto_open_forms !== false}
        />
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
