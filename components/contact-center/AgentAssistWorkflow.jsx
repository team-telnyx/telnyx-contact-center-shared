"use client";

import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import useWorkflowStore from "@/lib/stores/workflow-store";
import useActiveCallStore from "@/lib/stores/active-call-store";
import {
  ClipboardList,
  MessageSquare,
  Sparkles,
  CheckCircle,
  Circle,
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
export function AgentAssistWorkflow({ interactionId, workflowId }) {
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
    fetchSession,
    startWorkflow,
    analyzeTranscript,
    completeItem,
    skipItem,
  } = useWorkflowStore();

  // Get transcriptions from active call store
  const transcriptions = useActiveCallStore((state) => state.transcriptions);

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
    <div className="flex flex-col h-full gap-3 overflow-hidden">
      {/* Main 3-column layout */}
      <div className="flex-1 min-h-0 grid grid-cols-12 gap-3">
        {/* Left: Workflow Stages & Items */}
        <div className="col-span-5">
          <WorkflowStagesCard
            stages={stages}
            itemStatuses={itemStatuses}
            isAnalyzing={isAnalyzing}
            onCompleteItem={completeItem}
            onSkipItem={skipItem}
          />
        </div>

        {/* Center: Live Transcription */}
        <div className="col-span-4">
          <LiveTranscriptionCard transcriptions={transcriptions} />
        </div>

        {/* Right: Suggested Responses */}
        <div className="col-span-3">
          <SuggestedResponsesCard transcriptions={transcriptions} />
        </div>
      </div>

      {/* Bottom: Progress Bar */}
      <WorkflowProgressBar
        stages={stages}
        itemStatuses={itemStatuses}
        completionPercentage={completionPercentage}
        completedItems={completedItems}
        totalItems={totalItems}
        isComplete={session?.status === "completed"}
      />
    </div>
  );
}

/**
 * Workflow Stages Card with Accordions
 */
function WorkflowStagesCard({ stages, itemStatuses, isAnalyzing, onCompleteItem, onSkipItem }) {
  // Find currently active stage (first stage with incomplete items)
  const activeStageId = useMemo(() => {
    for (const stage of stages) {
      const hasIncomplete = stage.items?.some((item) => {
        const status = itemStatuses[item.id]?.status;
        return status !== "completed" && status !== "skipped";
      });
      if (hasIncomplete) return stage.id;
    }
    return stages[0]?.id;
  }, [stages, itemStatuses]);

  // Find recently completed item (for highlighting)
  const recentlyCompletedRef = useRef(null);
  const [highlightedItemId, setHighlightedItemId] = useState(null);

  useEffect(() => {
    // Clear highlight after 2 seconds
    if (highlightedItemId) {
      const timer = setTimeout(() => setHighlightedItemId(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [highlightedItemId]);

  return (
    <Card className="h-full flex flex-col border-2 border-border">
      <CardHeader className="pb-2 flex-shrink-0">
        <CardTitle className="text-sm flex items-center gap-2">
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
      <CardContent className="flex-1 min-h-0 p-0">
        <ScrollArea className="h-full">
          <div className="px-4 pb-4">
            <Accordion
              type="single"
              collapsible
              defaultValue={activeStageId}
              value={activeStageId}
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
                                <p
                                  className={`text-sm leading-tight ${
                                    isCompleted || isSkipped
                                      ? "line-through text-muted-foreground"
                                      : ""
                                  }`}
                                >
                                  {item.label}
                                </p>
                                {status.confidence_score && (
                                  <div className="flex items-center gap-1 mt-1">
                                    <Badge
                                      variant="outline"
                                      className={`text-xs ${
                                        status.confidence_score >= 0.85
                                          ? "bg-green-500/10 text-green-500 border-green-500/50"
                                          : "bg-amber-500/10 text-amber-500 border-amber-500/50"
                                      }`}
                                    >
                                      AI: {Math.round(status.confidence_score * 100)}%
                                    </Badge>
                                  </div>
                                )}
                              </div>
                              <ItemTypeBadge type={item.type} />
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
function LiveTranscriptionCard({ transcriptions }) {
  const scrollRef = useRef(null);
  const endRef = useRef(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptions]);

  // Filter to only final transcriptions
  const finalTranscriptions = transcriptions.filter((t) => t.isFinal);

  return (
    <Card className="h-full flex flex-col border-2 border-border">
      <CardHeader className="pb-2 flex-shrink-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-blue-500" />
          Live Transcription
          {finalTranscriptions.length > 0 && (
            <Badge variant="outline" className="ml-auto text-xs">
              {finalTranscriptions.length} messages
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0">
        <ScrollArea className="h-full" ref={scrollRef}>
          <div className="px-4 pb-4 space-y-3">
            {finalTranscriptions.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Waiting for conversation...</p>
              </div>
            ) : (
              finalTranscriptions.map((t) => (
                <TranscriptionBubble key={t.id} transcription={t} />
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
function TranscriptionBubble({ transcription }) {
  const isCustomer = transcription.track === "inbound";
  const sentiment = transcription.sentiment;
  const sentimentScore = transcription.sentimentScore;
  const intent = transcription.intent;

  const SentimentIcon = sentiment === "positive" ? Smile :
    sentiment === "negative" ? Frown : Meh;

  const sentimentColor = sentiment === "positive" ? "text-green-500" :
    sentiment === "negative" ? "text-red-500" : "text-gray-400";

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
 * Suggested Responses Card
 */
function SuggestedResponsesCard({ transcriptions }) {
  // Generate suggested responses based on latest transcription
  // In a real implementation, these would come from LLM analysis
  const suggestions = useMemo(() => {
    const latestCustomer = [...transcriptions]
      .reverse()
      .find((t) => t.track === "inbound" && t.isFinal);

    if (!latestCustomer) return [];

    // Mock suggestions - in production, these come from the analyze API
    const mockSuggestions = [
      {
        id: "1",
        text: "Thank you for your patience. Let me help you with that.",
        type: "empathy",
      },
      {
        id: "2",
        text: "I understand your concern. I'll resolve this right away.",
        type: "resolution",
      },
      {
        id: "3",
        text: "Could you please provide me with your account number?",
        type: "information",
      },
    ];

    return mockSuggestions;
  }, [transcriptions]);

  return (
    <Card className="h-full flex flex-col border-2 border-border">
      <CardHeader className="pb-2 flex-shrink-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          AI Suggestions
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0">
        <ScrollArea className="h-full">
          <div className="px-4 pb-4 space-y-2">
            {suggestions.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Listening for context...</p>
                <p className="text-xs mt-1">Suggestions appear as conversation develops</p>
              </div>
            ) : (
              suggestions.map((suggestion) => (
                <SuggestionBubble key={suggestion.id} suggestion={suggestion} />
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/**
 * Single suggestion bubble
 */
function SuggestionBubble({ suggestion }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(suggestion.text);
    setCopied(true);
    notify({
      title: "Copied to clipboard",
      description: "Paste in your response",
      variant: "success",
    });
    setTimeout(() => setCopied(false), 2000);
  };

  const typeConfig = {
    empathy: { color: "bg-pink-500/10 text-pink-500 border-pink-500/50" },
    resolution: { color: "bg-green-500/10 text-green-500 border-green-500/50" },
    information: { color: "bg-blue-500/10 text-blue-500 border-blue-500/50" },
  };

  return (
    <div
      className="group p-3 rounded-lg border border-border bg-card hover:border-amber-500/50 hover:bg-amber-500/5 transition-all cursor-pointer"
      onClick={handleCopy}
    >
      <div className="flex items-start gap-2">
        <Bot className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-relaxed">{suggestion.text}</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge
              variant="outline"
              className={`text-[10px] capitalize ${
                typeConfig[suggestion.type]?.color || "bg-muted"
              }`}
            >
              {suggestion.type}
            </Badge>
            <span className="text-xs text-muted-foreground group-hover:text-amber-500 flex items-center gap-1 ml-auto">
              {copied ? (
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
  return (
    <div className="bg-card border-2 border-border rounded-lg p-3 flex-shrink-0">
      <div className="flex items-center gap-4">
        {/* Stage indicators */}
        <div className="flex items-center gap-1">
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
            value={completionPercentage}
            className="h-2"
          />
        </div>

        {/* Percentage and count */}
        <div className="flex items-center gap-2 flex-shrink-0">
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
            {completionPercentage}%
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
