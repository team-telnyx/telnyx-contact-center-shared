"use client";

import { useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import useWorkflowStore from "@/lib/stores/workflow-store";
import useActiveCallStore from "@/lib/stores/active-call-store";
import { WorkflowStageNav } from "./WorkflowStageNav";
import { WorkflowChecklist } from "./WorkflowChecklist";
import { WorkflowSlotsSummary } from "./WorkflowSlotsSummary";
import { WorkflowProgress } from "./WorkflowProgress";
import { ClipboardList, FileText } from "lucide-react";

/**
 * AgentAssistWorkflow Component
 * 
 * Main container component for the Agent Assist Workflow module.
 * Manages workflow session lifecycle and coordinates child components.
 */
export function AgentAssistWorkflow({ interactionId, workflowId }) {
  const {
    session,
    isLoading,
    error,
    fetchSession,
    startWorkflow,
    analyzeTranscript,
    clearSession,
  } = useWorkflowStore();

  // Get transcriptions from active call store
  const transcriptions = useActiveCallStore((state) => state.transcriptions);
  
  // Track last analyzed transcription
  const lastTranscriptionIdRef = useCallback(() => {
    return transcriptions.length > 0 
      ? transcriptions[transcriptions.length - 1].id 
      : null;
  }, [transcriptions]);

  // Initialize workflow session
  useEffect(() => {
    if (!interactionId) return;

    // Try to fetch existing session first
    fetchSession(interactionId).then((existingSession) => {
      // If no session exists and workflowId is provided, start new session
      if (!existingSession && workflowId) {
        startWorkflow(interactionId, workflowId).catch((err) => {
          console.error("[AgentAssistWorkflow] Failed to start workflow:", err);
        });
      }
    }).catch((err) => {
      console.error("[AgentAssistWorkflow] Failed to fetch session:", err);
    });

    // Cleanup on unmount
    return () => {
      // Don't clear session on unmount - let it persist
    };
  }, [interactionId, workflowId, fetchSession, startWorkflow]);

  // Analyze new transcriptions as they come in
  useEffect(() => {
    if (!session || transcriptions.length === 0) return;

    const latestTranscription = transcriptions[transcriptions.length - 1];
    
    // Only analyze final transcriptions
    if (!latestTranscription.isFinal) return;

    // Debounce: only analyze if this is a new transcription
    const analyzeIfNew = async () => {
      try {
        await analyzeTranscript(
          latestTranscription.transcript,
          latestTranscription.track // 'inbound' or 'outbound'
        );
      } catch (err) {
        console.error("[AgentAssistWorkflow] Analysis error:", err);
      }
    };

    // Small delay to batch rapid transcriptions
    const timer = setTimeout(analyzeIfNew, 500);
    return () => clearTimeout(timer);
  }, [session, transcriptions, analyzeTranscript]);

  // Show loading state
  if (isLoading && !session) {
    return (
      <Card className="border-2 border-border bg-card h-full">
        <CardContent className="flex items-center justify-center h-full">
          <div className="text-center text-muted-foreground">
            <div className="animate-spin h-8 w-8 border-4 border-purple-500 border-t-transparent rounded-full mx-auto mb-2" />
            <p className="text-sm">Loading workflow...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show error state
  if (error && !session) {
    return (
      <Card className="border-2 border-border bg-card h-full">
        <CardContent className="flex items-center justify-center h-full">
          <div className="text-center text-muted-foreground">
            <p className="text-sm text-red-500">{error}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show empty state if no session
  if (!session) {
    return (
      <Card className="border-2 border-border bg-card h-full">
        <CardContent className="flex items-center justify-center h-full">
          <div className="text-center text-muted-foreground">
            <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No workflow active</p>
            <p className="text-xs mt-1">Start a call to begin workflow</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Stage Navigation */}
      <WorkflowStageNav />

      {/* Main Content */}
      <div className="flex-1 min-h-0 grid grid-cols-3 gap-3">
        {/* Checklist (2/3 width) */}
        <div className="col-span-2">
          <WorkflowChecklist />
        </div>

        {/* Slots Summary (1/3 width) */}
        <div className="col-span-1">
          <WorkflowSlotsSummary />
        </div>
      </div>

      {/* Progress Bar */}
      <WorkflowProgress />
    </div>
  );
}

/**
 * AgentAssistWorkflowPanel
 * 
 * Wrapper component that adds the workflow as a tab alongside existing AgentAssist.
 */
export function AgentAssistWorkflowPanel({ interactionId, workflowId, children }) {
  const session = useWorkflowStore((state) => state.session);

  return (
    <Tabs defaultValue="workflow" className="h-full flex flex-col">
      <TabsList className="w-full justify-start bg-muted/50 px-2">
        <TabsTrigger value="workflow" className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4" />
          Workflow
          {session && (
            <span className="text-xs bg-purple-500/20 text-purple-500 px-1.5 py-0.5 rounded">
              {session.status === "completed" ? "✓" : "Active"}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="assist" className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Agent Assist
        </TabsTrigger>
      </TabsList>

      <TabsContent value="workflow" className="flex-1 mt-3 overflow-hidden">
        <AgentAssistWorkflow interactionId={interactionId} workflowId={workflowId} />
      </TabsContent>

      <TabsContent value="assist" className="flex-1 mt-3 overflow-hidden">
        {children}
      </TabsContent>
    </Tabs>
  );
}

export default AgentAssistWorkflow;
