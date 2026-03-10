"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import useWorkflowStore from "@/lib/stores/workflow-store";
import useActiveCallStore from "@/lib/stores/active-call-store";
import ReactMarkdown from "react-markdown";
import {
  ClipboardList,
  MessageSquare,
  Sparkles,
  CheckCircle,
  Loader2,
  Copy,
  CheckCheck,
  User,
  Headphones,
  Bot,
  ChevronRight,
  Smile,
  Meh,
  Frown,
  Pencil,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Brain,
  Heart,
  AlertCircle,
  Volume2,
} from "lucide-react";
import { notify } from "@/components/ToastNotify";

/**
 * AgentAssistWorkflow Component
 * 
 * Redesigned 3-column layout with:
 * 1. Workflow Stages & Items (left) - Accordions with checkboxes
 * 2. Live Transcription (center) - Chat bubbles with intent/sentiment
 * 3. Suggested Responses (right) - AI suggestions to copy
 * 4. Progress Bar (bottom) - Overall completion
 */
export function AgentAssistWorkflow({ interactionId, workflowId, interaction }) {
  const {
    session,
    stages,
    itemStatuses,
    isLoading,
    isAnalyzing,
    error,
    completionPercentage,
    completedItems,
    totalItems,
    aiHandoff,
    fetchSession,
    startWorkflow,
    analyzeTranscript,
    completeItem,
    skipItem,
    setAiAssisted,
    setAiDataLoading,
    applyAiHandoffData,
  } = useWorkflowStore();

  // Get transcriptions and call state from active call store
  const transcriptions = useActiveCallStore((state) => state.transcriptions);
  const callState = useActiveCallStore((state) => state.call?.state);
  const activeCall = useActiveCallStore((state) => state.call);

  // AI Handoff polling timeout ref
  const aiPollTimeoutRef = useRef(null);
  const aiPollCountRef = useRef(0);
  const AI_POLL_MAX_ATTEMPTS = 10; // 10 attempts * 3 seconds = 30 seconds
  const AI_POLL_INTERVAL_MS = 3000;

  // Check if interaction has ai_call_control_id (AI assisted call)
  const aiCallControlId = useMemo(() => {
    return interaction?.metadata?.ai_call_control_id || 
           interaction?.ai_call_control_id || 
           activeCall?.aiCallControlId ||
           activeCall?.contactCenter?.aiCallControlId ||
           null;
  }, [interaction, activeCall]);

  // Set AI assisted flag when ai_call_control_id is detected
  useEffect(() => {
    if (aiCallControlId && !aiHandoff.isAiAssisted) {
      console.log("[AgentAssistWorkflow] AI-assisted call detected:", aiCallControlId);
      setAiAssisted(true);
    }
  }, [aiCallControlId, aiHandoff.isAiAssisted, setAiAssisted]);

  // SSE subscription for ai_handoff_data events
  useEffect(() => {
    if (!interactionId) return;

    // Subscribe to SSE for AI handoff data
    let eventSource = null;
    try {
      eventSource = new EventSource("/api/contact-center/agent/stream");
      
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "ai_handoff_data" && data.interactionId === interactionId) {
            console.log("[AgentAssistWorkflow] Received AI handoff data via SSE:", data);
            
            // Apply the AI data to workflow state
            applyAiHandoffData(data.data);
            
            // Count pre-filled slots
            const slotCount = Object.keys(data.data?.slots_filled || {}).length;
            notify({
              title: "🤖 AI data received",
              description: slotCount > 0 
                ? `${slotCount} slot${slotCount !== 1 ? 's' : ''} pre-filled`
                : "Call summary and sentiment available",
              variant: "success",
            });
            
            // Cancel any pending polling
            if (aiPollTimeoutRef.current) {
              clearTimeout(aiPollTimeoutRef.current);
              aiPollTimeoutRef.current = null;
            }
          }
        } catch (e) {
          // Ignore parse errors for non-JSON messages
        }
      };
    } catch (err) {
      console.error("[AgentAssistWorkflow] Failed to set up SSE:", err);
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [interactionId, applyAiHandoffData]);

  // Polling fallback for AI data when SSE hasn't delivered
  useEffect(() => {
    if (!aiHandoff.isAiAssisted || aiHandoff.aiDataReceived || !interactionId) {
      return;
    }

    const pollAiContext = async () => {
      if (aiPollCountRef.current >= AI_POLL_MAX_ATTEMPTS) {
        console.log("[AgentAssistWorkflow] AI data poll timeout reached, giving up");
        setAiDataLoading(false);
        return;
      }

      try {
        const res = await fetch(
          `/api/agent-assist/workflow/ai-context?interactionId=${encodeURIComponent(interactionId)}`
        );
        const result = await res.json();

        if (result.status === "available" && result.data) {
          console.log("[AgentAssistWorkflow] AI data received via polling:", result.data);
          applyAiHandoffData(result.data);
          
          const slotCount = Object.keys(result.data?.slots_filled || {}).length;
          notify({
            title: "🤖 AI data received",
            description: slotCount > 0 
              ? `${slotCount} slot${slotCount !== 1 ? 's' : ''} pre-filled`
              : "Call summary and sentiment available",
            variant: "success",
          });
          return;
        }

        // Still pending, schedule next poll
        aiPollCountRef.current++;
        aiPollTimeoutRef.current = setTimeout(pollAiContext, AI_POLL_INTERVAL_MS);
      } catch (err) {
        console.error("[AgentAssistWorkflow] AI context poll error:", err);
        aiPollCountRef.current++;
        aiPollTimeoutRef.current = setTimeout(pollAiContext, AI_POLL_INTERVAL_MS);
      }
    };

    // Start polling after a short delay (give SSE a chance first)
    aiPollTimeoutRef.current = setTimeout(pollAiContext, 2000);

    return () => {
      if (aiPollTimeoutRef.current) {
        clearTimeout(aiPollTimeoutRef.current);
      }
    };
  }, [aiHandoff.isAiAssisted, aiHandoff.aiDataReceived, interactionId, applyAiHandoffData, setAiDataLoading]);

  // Track suggestions for saving to history (use refs directly for unmount access)
  const suggestionsRef = useRef([]);
  const transcriptionsRef = useRef([]);
  const sessionIdRef = useRef(null);
  const hasSavedRef = useRef(false);

  // Keep refs updated synchronously
  transcriptionsRef.current = transcriptions;
  if (session?.id) {
    sessionIdRef.current = session.id;
  }

  // Function to save workflow history
  const saveWorkflowHistory = useCallback(() => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      console.log("[AgentAssistWorkflow] Cannot save - no session ID");
      return;
    }
    
    if (hasSavedRef.current) {
      console.log("[AgentAssistWorkflow] Already saved, skipping");
      return;
    }
    
    const currentTranscriptions = transcriptionsRef.current;
    const currentSuggestions = suggestionsRef.current;
    
    console.log("[AgentAssistWorkflow] Saving history:", {
      sessionId: currentSessionId,
      transcriptionsCount: currentTranscriptions.length,
      suggestionsCount: currentSuggestions.length,
    });

    if (currentTranscriptions.length === 0 && currentSuggestions.length === 0) {
      console.log("[AgentAssistWorkflow] No data to save");
      return;
    }

    hasSavedRef.current = true;

    // Fire and forget - save history data
    fetch("/api/agent-assist/workflow/save-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: currentSessionId,
        transcriptions: currentTranscriptions.filter(t => t.isFinal).map(t => ({
          id: t.id,
          transcript: t.transcript,
          track: t.track,
          timestamp: t.timestamp,
          isFinal: t.isFinal,
          sentiment: t.sentiment,
          sentimentScore: t.sentimentScore,
          intent: t.intent,
          tags: t.tags,
        })),
        suggestions: currentSuggestions.map(s => ({
          id: s.id,
          text: s.text,
          stageName: s.stageName,
          itemId: s.itemId,
          itemLabel: s.itemLabel,
          itemType: s.itemType,
          slotOptions: s.slotOptions,
          timestamp: s.timestamp,
        })),
      }),
    }).then(res => {
      if (res.ok) {
        console.log("[AgentAssistWorkflow] History saved successfully");
      } else {
        console.error("[AgentAssistWorkflow] Failed to save history:", res.status);
        hasSavedRef.current = false; // Allow retry
      }
    }).catch(err => {
      console.error("[AgentAssistWorkflow] Failed to save history:", err);
      hasSavedRef.current = false; // Allow retry
    });
  }, []);

  // Save when call ends (detected by call state change or call becoming null)
  useEffect(() => {
    // If call state changes to hangup/completed, or call becomes null
    if (!activeCall || callState === "hangup" || callState === "completed") {
      if (sessionIdRef.current && !hasSavedRef.current) {
        console.log("[AgentAssistWorkflow] Call ended, saving history. callState:", callState);
        saveWorkflowHistory();
      }
    }
  }, [activeCall, callState, saveWorkflowHistory]);

  // Also save on unmount as backup
  useEffect(() => {
    return () => {
      if (!hasSavedRef.current) {
        console.log("[AgentAssistWorkflow] Unmounting, saving history");
        saveWorkflowHistory();
      }
    };
  }, [saveWorkflowHistory]);

  // Callback for when suggestions change - update ref directly for unmount access
  const handleSuggestionsChange = useCallback((suggestions) => {
    suggestionsRef.current = suggestions;
  }, []);

  // Initialize workflow session
  useEffect(() => {
    if (!interactionId) return;

    fetchSession(interactionId).then((existingSession) => {
      if (!existingSession && workflowId) {
        startWorkflow(interactionId, workflowId).catch((err) => {
          console.error("[AgentAssistWorkflow] Failed to start workflow:", err);
        });
      }
    }).catch((err) => {
      console.error("[AgentAssistWorkflow] Failed to fetch session:", err);
    });
  }, [interactionId, workflowId, fetchSession, startWorkflow]);

  // Analyze new transcriptions as they come in
  useEffect(() => {
    if (!session || transcriptions.length === 0) return;

    const latestTranscription = transcriptions[transcriptions.length - 1];
    if (!latestTranscription.isFinal) return;

    const analyzeIfNew = async () => {
      try {
        await analyzeTranscript(
          latestTranscription.transcript,
          latestTranscription.track
        );
      } catch (err) {
        console.error("[AgentAssistWorkflow] Analysis error:", err);
      }
    };

    const timer = setTimeout(analyzeIfNew, 500);
    return () => clearTimeout(timer);
  }, [session, transcriptions, analyzeTranscript]);

  // Find the current slot that needs filling (for suggested response)
  // MUST be before any conditional returns to maintain hook order
  const currentSlotNeedingFill = useMemo(() => {
    if (!stages || stages.length === 0) return null;
    for (const stage of stages) {
      for (const item of stage.items || []) {
        const status = itemStatuses[item.id];
        if (status?.status !== "completed" && status?.status !== "skipped") {
          return { stage, item };
        }
      }
    }
    return null;
  }, [stages, itemStatuses]);

  // Loading state
  if (isLoading && !session) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-purple-500" />
          <p className="text-sm">Loading workflow...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !session) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      </div>
    );
  }

  // No session state
  if (!session) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No workflow active</p>
          <p className="text-xs mt-1">Start a call to begin workflow</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* AI Assisted Badge */}
      {aiHandoff.isAiAssisted && (
        <div className="shrink-0 mb-3">
          <AiHandoffIndicator 
            isLoading={aiHandoff.aiDataLoading}
            isReceived={aiHandoff.aiDataReceived}
            receivedAt={aiHandoff.receivedAt}
          />
        </div>
      )}

      {/* AI Summary & Sentiment Panel (when available) */}
      {(aiHandoff.aiSummary || aiHandoff.aiSentiment) && (
        <div className="shrink-0 mb-3">
          <AiSummaryPanel 
            summary={aiHandoff.aiSummary}
            sentiment={aiHandoff.aiSentiment}
          />
        </div>
      )}

      {/* 3 karty - równa szerokość, scrollable */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: Workflow Stages & Items */}
        <WorkflowStagesCard
          stages={stages}
          itemStatuses={itemStatuses}
          isAnalyzing={isAnalyzing}
          onCompleteItem={completeItem}
          onSkipItem={skipItem}
          aiSlotsDetails={aiHandoff.slotsDetails}
        />

        {/* Center: Live Transcription */}
        <LiveTranscriptionCard
          transcriptions={transcriptions}
          translationConfig={interaction?.metadata?.agent_assist_config || {}}
          interactionId={interactionId}
        />

        {/* Right: Suggested Response (single) */}
        <SuggestedResponseCard 
          currentSlot={currentSlotNeedingFill} 
          onSuggestionsChange={handleSuggestionsChange}
        />
      </div>

      {/* Progress bar - fixed na dole */}
      <div className="shrink-0 mt-4">
        <WorkflowProgressBar
          stages={stages}
          itemStatuses={itemStatuses}
          completionPercentage={session?.completion_percentage ?? completionPercentage}
          completedItems={completedItems}
          totalItems={totalItems}
          isComplete={session?.status === "completed"}
        />
      </div>
    </div>
  );
}

/**
 * AI Handoff Indicator Component
 * Shows when call was AI-assisted and data loading/received status
 */
function AiHandoffIndicator({ isLoading, isReceived, receivedAt }) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border-2 ${
      isReceived 
        ? "bg-green-500/5 border-green-500/30" 
        : "bg-amber-500/5 border-amber-500/30 animate-pulse"
    }`}>
      <div className={`p-2 rounded-lg ${
        isReceived ? "bg-green-500/10" : "bg-amber-500/10"
      }`}>
        <Bot className={`h-5 w-5 ${
          isReceived ? "text-green-500" : "text-amber-500"
        }`} />
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">🤖 AI Assisted Call</span>
          {isReceived ? (
            <Badge variant="outline" className="text-xs bg-green-500/10 text-green-500 border-green-500/50">
              <CheckCircle className="h-3 w-3 mr-1" />
              Data Received
            </Badge>
          ) : isLoading ? (
            <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-500 border-amber-500/50">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Loading AI data...
            </Badge>
          ) : null}
        </div>
        {isReceived && receivedAt && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Received at {new Date(receivedAt).toLocaleTimeString()}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * AI Summary & Sentiment Panel
 * Collapsible panel showing AI-generated summary and sentiment analysis
 */
function AiSummaryPanel({ summary, sentiment }) {
  const [isOpen, setIsOpen] = useState(true);

  // Extract sentiment emoji from text if available
  const getSentimentEmoji = () => {
    if (!sentiment) return "😐";
    const lower = sentiment.toLowerCase();
    if (lower.includes("positive") || lower.includes("satisfied") || lower.includes("happy")) return "😊";
    if (lower.includes("negative") || lower.includes("frustrated") || lower.includes("angry")) return "😠";
    if (lower.includes("neutral")) return "😐";
    return "🤔";
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="border-2 border-purple-500/30 bg-purple-500/5">
        <CollapsibleTrigger className="w-full">
          <CardHeader className="py-3 px-4 cursor-pointer hover:bg-purple-500/5 transition-colors">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Brain className="h-4 w-4 text-purple-500" />
              AI Call Analysis
              <div className="flex items-center gap-2 ml-auto">
                {sentiment && (
                  <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-500 border-purple-500/50">
                    {getSentimentEmoji()} Sentiment
                  </Badge>
                )}
                {summary && (
                  <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-500 border-blue-500/50">
                    📝 Summary
                  </Badge>
                )}
                {isOpen ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            </CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 pb-4 px-4">
            <div className="grid grid-cols-2 gap-4">
              {/* Summary Column */}
              {summary && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-medium">Call Summary</span>
                  </div>
                  <div className="prose prose-xs dark:prose-invert max-w-none bg-muted/50 rounded-lg p-3 max-h-40 overflow-y-auto">
                    <ReactMarkdown
                      components={{
                        h1: ({ ...props }) => <h1 className="text-sm font-bold mb-2" {...props} />,
                        h2: ({ ...props }) => <h2 className="text-sm font-bold mb-2" {...props} />,
                        p: ({ ...props }) => <p className="text-xs leading-relaxed mb-2" {...props} />,
                        ul: ({ ...props }) => <ul className="list-disc list-inside text-xs mb-2" {...props} />,
                        li: ({ ...props }) => <li className="mb-0.5" {...props} />,
                        strong: ({ ...props }) => <strong className="font-bold" {...props} />,
                      }}
                    >
                      {summary}
                    </ReactMarkdown>
                  </div>
                </div>
              )}

              {/* Sentiment Column */}
              {sentiment && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Heart className="h-4 w-4 text-pink-500" />
                    <span className="text-sm font-medium">Sentiment Analysis</span>
                  </div>
                  <div className="prose prose-xs dark:prose-invert max-w-none bg-muted/50 rounded-lg p-3 max-h-40 overflow-y-auto">
                    <ReactMarkdown
                      components={{
                        h1: ({ ...props }) => <h1 className="text-sm font-bold mb-2" {...props} />,
                        h2: ({ ...props }) => <h2 className="text-sm font-bold mb-2" {...props} />,
                        p: ({ ...props }) => <p className="text-xs leading-relaxed mb-2" {...props} />,
                        ul: ({ ...props }) => <ul className="list-disc list-inside text-xs mb-2" {...props} />,
                        li: ({ ...props }) => <li className="mb-0.5" {...props} />,
                        strong: ({ ...props }) => <strong className="font-bold" {...props} />,
                      }}
                    >
                      {sentiment}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/**
 * Workflow Stages Card with Accordions
 */
function WorkflowStagesCard({ stages, itemStatuses, isAnalyzing, onCompleteItem, onSkipItem, aiSlotsDetails = {} }) {
  // Track which stage is expanded (user can manually toggle)
  const [expandedStage, setExpandedStage] = useState(null);

  // Find currently active stage (first stage with incomplete items)
  const activeStageId = useMemo(() => {
    for (const stage of stages) {
      const hasIncomplete = stage.items?.some((item) => {
        const status = itemStatuses[item.id]?.status;
        return status !== "completed" && status !== "skipped";
      });
      if (hasIncomplete) return stage.id;
    }
    return stages[stages.length - 1]?.id; // All complete - show last
  }, [stages, itemStatuses]);

  // Auto-expand next section when current section completes
  useEffect(() => {
    if (!expandedStage || expandedStage === activeStageId) {
      setExpandedStage(activeStageId);
    }
  }, [activeStageId]);

  // Track editing state for slot values
  const [editingItemId, setEditingItemId] = useState(null);
  const [editValue, setEditValue] = useState("");

  // Find recently completed item (for highlighting)
  const [highlightedItemId, setHighlightedItemId] = useState(null);

  useEffect(() => {
    // Clear highlight after 2 seconds
    if (highlightedItemId) {
      const timer = setTimeout(() => setHighlightedItemId(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [highlightedItemId]);

  const handleStartEdit = (item, currentValue) => {
    setEditingItemId(item.id);
    setEditValue(currentValue || "");
  };

  const handleSaveEdit = (itemId) => {
    // Here you would call an API to update the slot value
    // For now, we just complete the item with the value
    if (editValue.trim()) {
      onCompleteItem(itemId, editValue.trim());
    }
    setEditingItemId(null);
    setEditValue("");
  };

  const handleCancelEdit = () => {
    setEditingItemId(null);
    setEditValue("");
  };

  return (
    <Card className="w-1/3 flex flex-col overflow-hidden border-2 border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-purple-500" />
          Workflow Checklist
          {isAnalyzing && (
            <Badge variant="outline" className="ml-auto text-xs animate-pulse bg-purple-500/10 text-purple-500 border-purple-500/50">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Analyzing
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4">
            <Accordion
              type="single"
              collapsible
              value={expandedStage}
              onValueChange={setExpandedStage}
              className="w-full"
            >
              {stages.map((stage, stageIndex) => {
                const stageCompletion = getStageCompletion(stage, itemStatuses);
                const isActive = stage.id === activeStageId;

                return (
                  <AccordionItem
                    key={stage.id}
                    value={stage.id}
                    className={`border-b-0 mb-2 rounded-lg border ${
                      isActive
                        ? "border-purple-500/50 bg-purple-500/5"
                        : stageCompletion.isComplete
                        ? "border-green-500/50 bg-green-500/5"
                        : "border-border"
                    }`}
                  >
                    <AccordionTrigger className="px-3 py-2 hover:no-underline">
                      <div className="flex items-center gap-2 flex-1">
                        <span className={`flex items-center justify-center w-5 h-5 rounded-full text-xs font-medium ${
                          stageCompletion.isComplete
                            ? "bg-green-500 text-white"
                            : isActive
                            ? "bg-purple-500 text-white"
                            : "bg-muted text-muted-foreground"
                        }`}>
                          {stageCompletion.isComplete ? (
                            <CheckCircle className="h-3 w-3" />
                          ) : (
                            stageIndex + 1
                          )}
                        </span>
                        <span className="font-medium text-sm">{stage.name}</span>
                        <Badge
                          variant="outline"
                          className={`ml-auto text-xs ${
                            stageCompletion.isComplete
                              ? "bg-green-500/10 text-green-500 border-green-500/50"
                              : "bg-muted"
                          }`}
                        >
                          {stageCompletion.completed}/{stageCompletion.total}
                        </Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="px-3 pb-3">
                      <div className="space-y-1.5 pt-1">
                        {stage.items?.map((item) => {
                          const status = itemStatuses[item.id] || { status: "pending" };
                          const isCompleted = status.status === "completed";
                          const isSkipped = status.status === "skipped";
                          const isHighlighted = item.id === highlightedItemId;
                          const isEditing = editingItemId === item.id;
                          const slotValue = status.value || status.extracted_value;
                          const completedBy = status.completed_by; // 'ai' | 'agent' | null
                          const confidenceScore = status.confidence_score;
                          // Check AI slots details for additional context
                          const aiSlotInfo = item.slot_name ? aiSlotsDetails[item.slot_name] : null;
                          const isAiFilled = completedBy === "ai" || (aiSlotInfo?.value && !completedBy);
                          const isAgentFilled = completedBy === "agent";

                          return (
                            <div
                              key={item.id}
                              className={`flex items-start gap-2 p-2 rounded-md transition-all ${
                                isCompleted
                                  ? "bg-green-500/10"
                                  : isSkipped
                                  ? "bg-muted/50 opacity-60"
                                  : isHighlighted
                                  ? "bg-purple-500/20 ring-1 ring-purple-500"
                                  : "hover:bg-muted/50"
                              }`}
                            >
                              <Checkbox
                                checked={isCompleted}
                                disabled={isCompleted || isSkipped}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    onCompleteItem(item.id);
                                    setHighlightedItemId(item.id);
                                  }
                                }}
                                className={`mt-0.5 ${
                                  isCompleted ? "border-green-500 bg-green-500" : ""
                                }`}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p
                                    className={`text-sm leading-tight ${
                                      isCompleted || isSkipped
                                        ? "line-through text-muted-foreground"
                                        : ""
                                    }`}
                                  >
                                    {item.label}
                                  </p>
                                  <ItemTypeBadge type={item.type} />
                                </div>
                                
                                {/* Slot value display/edit */}
                                {item.type === "slot" && (
                                  <div className="mt-1.5">
                                    {isEditing ? (
                                      <div className="flex items-center gap-1">
                                        <Input
                                          value={editValue}
                                          onChange={(e) => setEditValue(e.target.value)}
                                          className="h-7 text-sm"
                                          placeholder={`Enter ${item.label.toLowerCase()}`}
                                          autoFocus
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter") handleSaveEdit(item.id);
                                            if (e.key === "Escape") handleCancelEdit();
                                          }}
                                        />
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-7 w-7 text-green-500 hover:text-green-600"
                                          onClick={() => handleSaveEdit(item.id)}
                                        >
                                          <Check className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                          onClick={handleCancelEdit}
                                        >
                                          <X className="h-3.5 w-3.5" />
                                        </Button>
                                      </div>
                                    ) : slotValue ? (
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-sm font-medium text-foreground">
                                          {slotValue}
                                        </span>
                                        {/* Source indicator: AI or Agent */}
                                        {isAiFilled ? (
                                          <span className="text-sm" title="Filled by AI Assistant">🤖</span>
                                        ) : isAgentFilled ? (
                                          <span className="text-sm" title="Filled by Agent">👤</span>
                                        ) : null}
                                        {/* Confidence indicator for AI-filled slots */}
                                        {isAiFilled && confidenceScore !== null && confidenceScore !== undefined && (
                                          <Badge
                                            variant="outline"
                                            className={`text-[10px] px-1.5 py-0 ${
                                              confidenceScore >= 0.7
                                                ? "bg-green-500/10 text-green-500 border-green-500/50"
                                                : confidenceScore >= 0.5
                                                ? "bg-amber-500/10 text-amber-500 border-amber-500/50"
                                                : "bg-red-500/10 text-red-500 border-red-500/50"
                                            }`}
                                            title={`AI confidence: ${Math.round(confidenceScore * 100)}%`}
                                          >
                                            {Math.round(confidenceScore * 100)}%
                                          </Badge>
                                        )}
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-5 w-5 text-muted-foreground hover:text-foreground"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleStartEdit(item, slotValue);
                                          }}
                                          title="Edit value"
                                        >
                                          <Pencil className="h-3 w-3" />
                                        </Button>
                                      </div>
                                    ) : (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleStartEdit(item, "");
                                        }}
                                      >
                                        <Pencil className="h-3 w-3 mr-1" />
                                        Enter value
                                      </Button>
                                    )}
                                  </div>
                                )}
                                
                                {/* Source and confidence for non-slot completed items */}
                                {item.type !== "slot" && isCompleted && (
                                  <div className="flex items-center gap-1.5 mt-1">
                                    {isAiFilled ? (
                                      <span className="text-sm" title="Completed by AI Assistant">🤖</span>
                                    ) : isAgentFilled ? (
                                      <span className="text-sm" title="Completed by Agent">👤</span>
                                    ) : null}
                                    {isAiFilled && confidenceScore !== null && confidenceScore !== undefined && (
                                      <Badge
                                        variant="outline"
                                        className={`text-xs ${
                                          confidenceScore >= 0.7
                                            ? "bg-green-500/10 text-green-500 border-green-500/50"
                                            : confidenceScore >= 0.5
                                            ? "bg-amber-500/10 text-amber-500 border-amber-500/50"
                                            : "bg-red-500/10 text-red-500 border-red-500/50"
                                        }`}
                                      >
                                        {Math.round(confidenceScore * 100)}%
                                      </Badge>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/**
 * Item type badge
 */
function ItemTypeBadge({ type }) {
  const config = {
    action: { color: "bg-blue-500/10 text-blue-500 border-blue-500/50", label: "Action" },
    question: { color: "bg-amber-500/10 text-amber-500 border-amber-500/50", label: "Question" },
    topic: { color: "bg-green-500/10 text-green-500 border-green-500/50", label: "Topic" },
    slot: { color: "bg-purple-500/10 text-purple-500 border-purple-500/50", label: "Data" },
  };
  const { color, label } = config[type] || { color: "bg-muted", label: type };

  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${color}`}>
      {label}
    </Badge>
  );
}

/**
 * Live Transcription Card with chat bubbles
 */
function LiveTranscriptionCard({ transcriptions, translationConfig, interactionId }) {
  const scrollRef = useRef(null);
  const endRef = useRef(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptions]);

  // Filter to only final transcriptions
  const finalTranscriptions = transcriptions.filter((t) => t.isFinal);

  return (
    <Card className="w-1/3 flex flex-col overflow-hidden border-2 border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-blue-500" />
          Live Transcription
          {finalTranscriptions.length > 0 && (
            <Badge variant="outline" className="ml-auto text-xs">
              {finalTranscriptions.length} messages
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
        <ScrollArea className="h-full" ref={scrollRef}>
          <div className="p-4 space-y-3">
            {finalTranscriptions.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Waiting for conversation...</p>
              </div>
            ) : (
              finalTranscriptions.map((t) => (
                <TranscriptionBubble
                  key={t.id}
                  transcription={t}
                  translationConfig={translationConfig}
                  interactionId={interactionId}
                />
              ))
            )}
            <div ref={endRef} />
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/**
 * Single transcription bubble
 */
function TranscriptionBubble({ transcription, translationConfig, interactionId }) {
  const isCustomer = transcription.track === "inbound";
  const sentiment = transcription.sentiment;
  const sentimentScore = transcription.sentimentScore;
  const intent = transcription.intent;
  const [isSpeaking, setIsSpeaking] = useState(false);

  const SentimentIcon = sentiment === "positive" ? Smile :
    sentiment === "negative" ? Frown : Meh;

  const sentimentColor = sentiment === "positive" ? "text-green-500" :
    sentiment === "negative" ? "text-red-500" : "text-gray-400";

  const translation = transcription.translation;
  const showTranslation = Boolean(translation?.text);
  const autoSendEnabled = translationConfig?.auto_send_response === true;
  const manualAllowed = showTranslation && !autoSendEnabled;

  const handleSpeakTranslation = async () => {
    if (!manualAllowed || !interactionId || !transcription.callControlId || !translation?.text) return;

    try {
      setIsSpeaking(true);
      const resp = await fetch("/api/agent-assist/workflow/speak-translation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interactionId,
          sourceCallControlId: transcription.callControlId,
          text: translation.text,
          targetLanguage: translation.targetLanguage || null,
          targetLeg: isCustomer ? "agent" : "caller",
        }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to speak translation");
      }
    } catch (err) {
      notify({
        title: "TTS failed",
        description: err.message || "Failed to send TTS",
        variant: "error",
      });
    } finally {
      setIsSpeaking(false);
    }
  };

  return (
    <div className={`flex flex-col ${isCustomer ? "items-start" : "items-end"}`}>
      {/* Speaker label */}
      <div className={`flex items-center gap-1 mb-1 text-xs text-muted-foreground ${
        isCustomer ? "" : "flex-row-reverse"
      }`}>
        {isCustomer ? (
          <User className="h-3 w-3" />
        ) : (
          <Headphones className="h-3 w-3" />
        )}
        <span>{isCustomer ? "Customer" : "Agent"}</span>
      </div>

      {/* Message bubble */}
      <div
        className={`max-w-[90%] rounded-xl px-3 py-2 ${
          isCustomer
            ? "bg-muted rounded-tl-sm"
            : "bg-purple-500/20 text-foreground rounded-tr-sm"
        }`}
      >
        <p className="text-sm leading-relaxed">{transcription.transcript}</p>
      </div>

      {/* Translation bubble */}
      {showTranslation && (
        <div className={`max-w-[90%] rounded-xl px-3 py-2 mt-1 border ${
          isCustomer
            ? "bg-blue-500/10 border-blue-500/30 text-foreground rounded-tl-sm"
            : "bg-emerald-500/10 border-emerald-500/30 text-foreground rounded-tr-sm"
        }`}>
          <div className="flex items-center gap-2">
            <p className="text-sm leading-relaxed flex-1">{translation.text}</p>
            {manualAllowed && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={handleSpeakTranslation}
                disabled={isSpeaking}
                title="Play translation"
              >
                <Volume2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {autoSendEnabled && (
              <Badge variant="outline" className="text-[10px]">auto</Badge>
            )}
          </div>
        </div>
      )}

      {/* Intent and sentiment badges */}
      {(intent || sentiment) && (
        <div className={`flex items-center gap-1.5 mt-1 ${
          isCustomer ? "" : "flex-row-reverse"
        }`}>
          {intent && (
            <Badge variant="outline" className="text-[10px] bg-blue-500/10 text-blue-500 border-blue-500/50">
              {intent}
            </Badge>
          )}
          {sentiment && (
            <div className={`flex items-center gap-0.5 ${sentimentColor}`}>
              <SentimentIcon className="h-3.5 w-3.5" />
              {typeof sentimentScore === "number" && (
                <span className="text-[10px]">{sentimentScore}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Generate a dynamic suggestion using LLM
 */
async function generateSuggestion(stage, item, session, transcriptions) {
  try {
    // Prepare conversation context (last 5 messages)
    const previousConversation = transcriptions
      .filter(t => t.isFinal)
      .slice(-5)
      .map(t => ({
        speaker: t.track === "inbound" ? "Customer" : "Agent",
        text: t.transcript,
      }));

    // Call API to generate suggestion
    const res = await fetch("/api/agent-assist/workflow/generate-suggestion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itemId: item.id,
        itemLabel: item.label,
        itemDescription: item.description,
        itemType: item.type,
        slotOptions: Array.isArray(item.slot_options) ? item.slot_options : null,
        workflowId: session?.workflow_id,
        agentName: session?.agent_name || "the agent",
        brandName: session?.brand_name,
        previousConversation,
      }),
    });

    if (!res.ok) {
      console.error("[generateSuggestion] API error:", res.status);
      // Fallback to static template
      return generateStaticSuggestion(stage, item);
    }

    const data = await res.json();
    if (!data.suggestion) {
      return generateStaticSuggestion(stage, item);
    }

    const slotOptions = Array.isArray(item.slot_options) ? item.slot_options : [];

    return {
      id: `${item.id}-${Date.now()}`,
      text: data.suggestion,
      stageName: stage.name,
      itemId: item.id,
      itemLabel: item.label,
      itemType: item.type,
      slotOptions: slotOptions.length > 0 ? slotOptions : null,
      timestamp: new Date(),
      model: data.model,
    };
  } catch (error) {
    console.error("[generateSuggestion] Error:", error);
    return generateStaticSuggestion(stage, item);
  }
}

/**
 * Fallback: Generate a static suggestion (when API fails)
 */
function generateStaticSuggestion(stage, item) {
  const questionTemplates = {
    slot: {
      name: "Could you please tell me your full name?",
      "customer name": "Could you please tell me your full name?",
      email: "What email address should I use for your account?",
      phone: "What's the best phone number to reach you?",
      address: "Could you provide your current address?",
      account: "Could you please provide your account number?",
      "account number": "Could you please provide your account number?",
      order: "What is your order number?",
      "order number": "What is your order number?",
      product: "Which product are you inquiring about?",
      issue: "Could you describe the issue you're experiencing?",
      default: `Could you please provide your ${item.label.toLowerCase()}?`,
    },
    question: {
      default: `${item.label}`,
    },
    action: {
      default: `I'll now ${item.label.toLowerCase()}.`,
    },
    topic: {
      default: `Let me help you with ${item.label.toLowerCase()}.`,
    },
  };

  const templates = questionTemplates[item.type] || questionTemplates.slot;
  const labelLower = item.label.toLowerCase();
  
  let text = templates.default;
  for (const [key, value] of Object.entries(templates)) {
    if (key !== "default" && labelLower.includes(key)) {
      text = value;
      break;
    }
  }

  const slotOptions = Array.isArray(item.slot_options) ? item.slot_options : [];
  if (item.type === "slot" && item.slot_type === "select" && slotOptions.length > 0) {
    text = `${text}\n\nPlease select: ${slotOptions.join(", ")}`;
  }

  return {
    id: `${item.id}-${Date.now()}`,
    text,
    stageName: stage.name,
    itemId: item.id,
    itemLabel: item.label,
    itemType: item.type,
    slotOptions: slotOptions.length > 0 ? slotOptions : null,
    timestamp: new Date(),
  };
}

/**
 * Suggested Response Card - Accumulating list of suggestions
 */
function SuggestedResponseCard({ currentSlot, onSuggestionsChange }) {
  const [suggestions, setSuggestions] = useState([]);
  const [copiedId, setCopiedId] = useState(null);
  const [generatingSuggestion, setGeneratingSuggestion] = useState(false);
  const scrollRef = useRef(null);
  const endRef = useRef(null);
  const lastItemIdRef = useRef(null);
  
  // Get session and transcriptions from stores
  const session = useWorkflowStore((state) => state.session);
  const transcriptions = useActiveCallStore((state) => state.transcriptions);

  // Add new suggestion when currentSlot changes to a new item
  useEffect(() => {
    if (!currentSlot) return;
    
    const { stage, item } = currentSlot;
    
    // Only add suggestion if this is a new item
    if (lastItemIdRef.current !== item.id) {
      lastItemIdRef.current = item.id;
      
      // Generate suggestion asynchronously
      setGeneratingSuggestion(true);
      generateSuggestion(stage, item, session, transcriptions)
        .then((newSuggestion) => {
          setSuggestions((prev) => {
            const updated = [...prev, newSuggestion];
            // Notify parent of suggestion change
            if (onSuggestionsChange) {
              onSuggestionsChange(updated);
            }
            return updated;
          });
        })
        .catch((err) => {
          console.error("[SuggestedResponseCard] Failed to generate suggestion:", err);
        })
        .finally(() => {
          setGeneratingSuggestion(false);
        });
    }
  }, [currentSlot, session, transcriptions, onSuggestionsChange]);

  // Auto-scroll to bottom when new suggestions added
  useEffect(() => {
    if (suggestions.length > 0) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [suggestions.length]);

  const handleCopy = (suggestion) => {
    navigator.clipboard.writeText(suggestion.text);
    setCopiedId(suggestion.id);
    notify({
      title: "Copied to clipboard",
      description: "Paste in your response",
      variant: "success",
    });
    setTimeout(() => setCopiedId(null), 2000);
  };

  const isComplete = !currentSlot && suggestions.length > 0;

  return (
    <Card className="w-1/3 flex flex-col overflow-hidden border-2 border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          Suggested Responses
          {generatingSuggestion && (
            <Badge variant="outline" className="ml-auto text-xs animate-pulse bg-amber-500/10 text-amber-500 border-amber-500/50">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Generating...
            </Badge>
          )}
          {!generatingSuggestion && suggestions.length > 0 && (
            <Badge variant="outline" className="ml-auto text-xs">
              {suggestions.length} suggestions
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
        <ScrollArea className="h-full" ref={scrollRef}>
          <div className="p-4 space-y-3">
            {suggestions.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Waiting for workflow...</p>
                <p className="text-xs mt-1">Suggestions will appear here</p>
              </div>
            ) : (
              <>
                {suggestions.map((suggestion, index) => {
                  const isCopied = copiedId === suggestion.id;
                  const isLatest = index === suggestions.length - 1;
                  
                  return (
                    <div
                      key={suggestion.id}
                      className={`group p-3 rounded-lg border-2 transition-all cursor-pointer ${
                        isLatest
                          ? "border-amber-500/50 bg-amber-500/5 hover:border-amber-500/80 hover:bg-amber-500/10"
                          : "border-border/50 bg-muted/30 hover:border-border hover:bg-muted/50"
                      }`}
                      onClick={() => handleCopy(suggestion)}
                    >
                      {/* Context badge */}
                      <div className="flex items-center gap-2 mb-2">
                        <Badge 
                          variant="outline" 
                          className={`text-[10px] ${
                            isLatest 
                              ? "bg-purple-500/10 text-purple-500 border-purple-500/50"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {suggestion.stageName}
                        </Badge>
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        <Badge 
                          variant="outline" 
                          className={`text-[10px] ${
                            isLatest
                              ? "bg-amber-500/10 text-amber-500 border-amber-500/50"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {suggestion.itemLabel}
                        </Badge>
                        {isLatest && (
                          <Badge className="text-[10px] bg-amber-500 text-white ml-auto">
                            Current
                          </Badge>
                        )}
                      </div>

                      {/* Suggestion text */}
                      <div className="flex items-start gap-2">
                        <Bot className={`h-4 w-4 mt-0.5 shrink-0 ${
                          isLatest ? "text-amber-500" : "text-muted-foreground"
                        }`} />
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm leading-relaxed whitespace-pre-wrap ${
                            isLatest ? "font-medium" : "text-muted-foreground"
                          }`}>
                            "{suggestion.text}"
                          </p>
                          
                          {/* Slot options badges */}
                          {suggestion.slotOptions && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {suggestion.slotOptions.map((opt) => (
                                <Badge 
                                  key={opt} 
                                  variant="outline" 
                                  className="text-[10px] bg-blue-500/10 text-blue-500 border-blue-500/50"
                                >
                                  {opt}
                                </Badge>
                              ))}
                            </div>
                          )}
                          
                          <div className="flex items-center gap-2 mt-2">
                            <span className={`text-xs flex items-center gap-1 ${
                              isCopied 
                                ? "text-green-500" 
                                : isLatest 
                                  ? "text-muted-foreground group-hover:text-amber-500"
                                  : "text-muted-foreground"
                            }`}>
                              {isCopied ? (
                                <>
                                  <CheckCheck className="h-3 w-3" />
                                  Copied!
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" />
                                  Click to copy
                                </>
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Completion message */}
                {isComplete && (
                  <div className="text-center text-muted-foreground py-4 border-t">
                    <CheckCircle className="h-6 w-6 mx-auto mb-2 text-green-500" />
                    <p className="text-sm font-medium text-green-600">All items completed!</p>
                    <p className="text-xs mt-1">Great job finishing the workflow</p>
                  </div>
                )}

                <div ref={endRef} />
              </>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/**
 * Progress Bar with stage indicators
 */
function WorkflowProgressBar({
  stages,
  itemStatuses,
  completionPercentage,
  completedItems,
  totalItems,
  isComplete,
}) {
  // Calculate percentage from items if not provided
  const displayPercentage = completionPercentage ?? 
    (totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0);

  return (
    <div className="bg-card border-2 border-border rounded-lg p-3">
      <div className="flex items-center gap-4">
        {/* Stage indicators */}
        <div className="flex items-center gap-1 shrink-0">
          {stages.map((stage, index) => {
            const completion = getStageCompletion(stage, itemStatuses);
            return (
              <div
                key={stage.id}
                className={`flex items-center ${index < stages.length - 1 ? "gap-1" : ""}`}
                title={`${stage.name}: ${completion.completed}/${completion.total}`}
              >
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-all ${
                    completion.isComplete
                      ? "bg-green-500 text-white"
                      : completion.completed > 0
                      ? "bg-purple-500/50 text-white"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {completion.isComplete ? (
                    <CheckCircle className="h-3.5 w-3.5" />
                  ) : (
                    index + 1
                  )}
                </div>
                {index < stages.length - 1 && (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )}
              </div>
            );
          })}
        </div>

        {/* Progress bar */}
        <div className="flex-1">
          <Progress
            value={displayPercentage}
            className="h-2"
            indicatorClassName="bg-green-500"
          />
        </div>

        {/* Percentage and count */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm text-muted-foreground">
            {completedItems}/{totalItems}
          </span>
          <Badge
            variant="outline"
            className={`text-sm font-bold ${
              isComplete
                ? "bg-green-500/10 text-green-500 border-green-500/50"
                : "bg-purple-500/10 text-purple-500 border-purple-500/50"
            }`}
          >
            {displayPercentage}%
          </Badge>
        </div>
      </div>
    </div>
  );
}

/**
 * Helper: Calculate stage completion
 */
function getStageCompletion(stage, itemStatuses) {
  if (!stage?.items) return { completed: 0, total: 0, isComplete: false };

  const total = stage.items.length;
  const completed = stage.items.filter((item) => {
    const status = itemStatuses[item.id];
    return status?.status === "completed";
  }).length;

  return {
    completed,
    total,
    isComplete: completed === total && total > 0,
  };
}

export default AgentAssistWorkflow;
