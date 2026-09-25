"use client";

import { useMemo } from "react";
import { DeviceHandoff } from "./DeviceHandoff";
import { AgentAssist } from "./AgentAssist";
import { AgentAssistWorkflow } from "./AgentAssistWorkflow";
import { AgentFormsView } from "./AgentFormsView";
import { AgentWebPagesView } from "./AgentWebPagesView";
import TransportMcpSubmitControl from "./TransportMcpSubmitControl";
import { Sparkles } from "lucide-react";

/**
 * InteractionDetail Component
 * 
 * Displays Agent Assist based on configuration:
 * - KB Articles mode: shows knowledge base article suggestions
 * - Workflows mode: shows full-width guided workflow (no tabs)
 * - Forms mode: opens selected/queue-assigned forms
 * - Web Pages mode: opens selected admin web pages
 * 
 * Configuration is read from:
 * 1. interaction.metadata.agent_assist_config (set by call flow node)
 * 2. Default: KB Articles mode
 */
export function InteractionDetail({ interaction }) {
  const activeVoice=interaction && ['voice','call'].includes(interaction.channel || interaction.interaction_type || 'voice')
    && ['active','connected','answered','held'].includes(interaction.state || interaction.status)
    && !interaction.completed_at && !interaction.abandoned_at;
  return <div className="flex h-full min-h-0 flex-col">
    {activeVoice && <div className="shrink-0 p-3"><DeviceHandoff key={interaction.id} interactionId={interaction.id}/></div>}
    <div className="min-h-0 flex-1"><InteractionAssistDetail interaction={interaction}/></div>
  </div>;
}
function InteractionAssistDetail({ interaction }) {
  const assistConfig = useMemo(() => interaction
    ? interaction.metadata?.agent_assist_config || {
      enabled: true, assist_type: "kb_articles", kb_auto_suggest: true, kb_max_suggestions: 3,
    } : null, [interaction]);

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
  const legacyWebPageId = Array.isArray(assistConfig?.web_page_ids)
    ? assistConfig.web_page_ids.find(Boolean)
    : null;
  const webPageIds = assistConfig?.web_page_id
    ? [assistConfig.web_page_id]
    : legacyWebPageId
      ? [legacyWebPageId]
      : [];

  // Workflows mode - full width workflow view without tabs
  if (assistType === "workflows" && workflowId) {
    return (
      <div className="relative flex flex-col h-full overflow-hidden p-3">
        <AgentAssistWorkflow 
          interactionId={interaction.id} 
          workflowId={workflowId}
          interaction={interaction}
        />
        {/* New-transport MCP submit lives beside the progress/count controls at
            the bottom-right. It renders nothing for workflows without a
            manual_submit create_transport binding. */}
        <div className="absolute bottom-6 right-28 z-20">
          <TransportMcpSubmitControl />
        </div>
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
          hideHeader
          showCards={false}
        />
      </div>
    );
  }

  if (assistType === "web_pages" || assistType === "web_page") {
    return (
      <div className="flex flex-col h-full overflow-hidden p-3">
        <AgentWebPagesView
          selectedInteraction={interaction}
          webPageIds={webPageIds}
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
