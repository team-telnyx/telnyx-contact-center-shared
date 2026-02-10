"use client";

import { useEffect, useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  ClipboardList,
  MessageSquare,
  Sparkles,
  CheckCircle,
  Loader2,
  User,
  Headphones,
  Bot,
  ChevronRight,
  Smile,
  Meh,
  Frown,
  SkipForward,
} from "lucide-react";

/**
 * WorkflowHistoryView Component
 * 
 * Read-only view of a completed workflow session.
 * Used in Call History to display workflow data for past calls.
 * Same 3-card layout as AgentAssistWorkflow but without edit capabilities.
 */
export default function WorkflowHistoryView({ interactionId }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch workflow session data and interaction metadata
  useEffect(() => {
    if (!interactionId) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        // Fetch workflow session
        const sessionUrl = new URL("/api/agent-assist/workflow/session", window.location.origin);
        sessionUrl.searchParams.set("interactionId", interactionId);
        
        const sessionResponse = await fetch(sessionUrl.toString());
        const sessionData = await sessionResponse.json();

        if (!sessionResponse.ok) {
          throw new Error(sessionData.error || "Failed to fetch workflow session");
        }

        // Fetch interaction metadata for transcriptions and suggestions
        const interactionResponse = await fetch(
          `/api/contact-center/interactions/${interactionId}`
        );
        const interactionData = await interactionResponse.json();

        // Extract agent_assist data from interaction metadata
        const agentAssist = interactionData?.interaction?.metadata?.agent_assist || {};
        
        // Merge session with transcriptions and suggestions from metadata
        if (sessionData.session) {
          sessionData.session.transcriptions = agentAssist.transcriptions || [];
          sessionData.session.suggestions = agentAssist.suggestions || [];
        }

        setSession(sessionData.session || null);
      } catch (err) {
        console.error("[WorkflowHistoryView] Error:", err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [interactionId]);

  // Extract data from session
  const stages = session?.stages || [];
  const itemStatuses = useMemo(() => {
    const statuses = {};
    stages.forEach((stage) => {
      stage.items?.forEach((item) => {
        if (item.status) {
          statuses[item.id] = item.status;
        }
      });
    });
    return statuses;
  }, [stages]);

  const totalItems = session?.totalItems || 0;
  const completedItems = session?.completedItems || 0;
  const completionPercentage = session?.completionPercentage || 0;

  // Get transcriptions and suggestions from session/metadata
  const transcriptions = session?.transcriptions || [];
  const suggestions = session?.suggestions || [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-purple-500" />
          <p className="text-sm">Loading workflow...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center text-muted-foreground">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center text-muted-foreground">
          <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No workflow data available</p>
          <p className="text-xs mt-1">This interaction did not use workflow mode</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 3 cards layout */}
      <div className="grid grid-cols-3 gap-4 h-[700px]">
        {/* Left: Workflow Stages & Items (Read-only) */}
        <WorkflowStagesCardReadOnly
          stages={stages}
          itemStatuses={itemStatuses}
          workflowName={session.workflow_name}
        />

        {/* Center: Transcription History */}
        <TranscriptionCardReadOnly transcriptions={transcriptions} />

        {/* Right: Suggested Responses History */}
        <SuggestionsHistoryCard suggestions={suggestions} />
      </div>

      {/* Progress bar */}
      <WorkflowProgressBarReadOnly
        stages={stages}
        itemStatuses={itemStatuses}
        completionPercentage={completionPercentage}
        completedItems={completedItems}
        totalItems={totalItems}
        isComplete={session.status === "completed"}
      />
    </div>
  );
}

/**
 * Read-only Workflow Stages Card
 */
function WorkflowStagesCardReadOnly({ stages, itemStatuses, workflowName }) {
  const [expandedStage, setExpandedStage] = useState(stages[0]?.id || null);

  return (
    <Card className="flex flex-col overflow-hidden border-2 border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-purple-500" />
          Workflow Checklist
          {workflowName && (
            <Badge variant="outline" className="ml-auto text-xs">
              {workflowName}
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

                return (
                  <AccordionItem
                    key={stage.id}
                    value={stage.id}
                    className={`border-b-0 mb-2 rounded-lg border ${
                      stageCompletion.isComplete
                        ? "border-green-500/50 bg-green-500/5"
                        : "border-border"
                    }`}
                  >
                    <AccordionTrigger className="px-3 py-2 hover:no-underline">
                      <div className="flex items-center gap-2 flex-1">
                        <span className={`flex items-center justify-center w-5 h-5 rounded-full text-xs font-medium ${
                          stageCompletion.isComplete
                            ? "bg-green-500 text-white"
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
                          const slotValue = status.value || status.extracted_value;
                          const isAiFilled = status.auto_filled || status.confidence_score;

                          return (
                            <div
                              key={item.id}
                              className={`flex items-start gap-2 p-2 rounded-md ${
                                isCompleted
                                  ? "bg-green-500/10"
                                  : isSkipped
                                  ? "bg-muted/50 opacity-60"
                                  : "bg-muted/30"
                              }`}
                            >
                              <div className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center ${
                                isCompleted
                                  ? "border-green-500 bg-green-500"
                                  : isSkipped
                                  ? "border-amber-500 bg-amber-500"
                                  : "border-muted-foreground"
                              }`}>
                                {isCompleted && <CheckCircle className="h-3 w-3 text-white" />}
                                {isSkipped && <SkipForward className="h-3 w-3 text-white" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className={`text-sm leading-tight ${
                                    isCompleted || isSkipped
                                      ? "line-through text-muted-foreground"
                                      : ""
                                  }`}>
                                    {item.label}
                                  </p>
                                  <ItemTypeBadge type={item.type} />
                                </div>
                                
                                {/* Slot value display */}
                                {item.type === "slot" && slotValue && (
                                  <div className="flex items-center gap-1.5 mt-1">
                                    <span className="text-sm font-medium text-foreground">
                                      {slotValue}
                                    </span>
                                    {isAiFilled && (
                                      <Badge
                                        variant="outline"
                                        className="text-[10px] px-1 py-0 bg-purple-500/10 text-purple-500 border-purple-500/50"
                                      >
                                        AI
                                      </Badge>
                                    )}
                                  </div>
                                )}

                                {/* Confidence score */}
                                {status.confidence_score && (
                                  <Badge
                                    variant="outline"
                                    className={`text-xs mt-1 ${
                                      status.confidence_score >= 0.85
                                        ? "bg-green-500/10 text-green-500 border-green-500/50"
                                        : "bg-amber-500/10 text-amber-500 border-amber-500/50"
                                    }`}
                                  >
                                    AI: {Math.round(status.confidence_score * 100)}%
                                  </Badge>
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
 * Read-only Transcription Card
 */
function TranscriptionCardReadOnly({ transcriptions }) {
  return (
    <Card className="flex flex-col overflow-hidden border-2 border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-blue-500" />
          Transcription
          {transcriptions.length > 0 && (
            <Badge variant="outline" className="ml-auto text-xs">
              {transcriptions.length} messages
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-3">
            {transcriptions.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No transcription data</p>
              </div>
            ) : (
              transcriptions.map((t, idx) => (
                <TranscriptionBubbleReadOnly key={t.id || idx} transcription={t} />
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/**
 * Single transcription bubble (read-only)
 */
function TranscriptionBubbleReadOnly({ transcription }) {
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
      <div className={`flex items-center gap-1 mb-1 text-xs text-muted-foreground ${
        isCustomer ? "" : "flex-row-reverse"
      }`}>
        {isCustomer ? <User className="h-3 w-3" /> : <Headphones className="h-3 w-3" />}
        <span>{isCustomer ? "Customer" : "Agent"}</span>
      </div>

      <div className={`max-w-[90%] rounded-xl px-3 py-2 ${
        isCustomer
          ? "bg-muted rounded-tl-sm"
          : "bg-purple-500/20 text-foreground rounded-tr-sm"
      }`}>
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
 * Suggestions History Card
 */
function SuggestionsHistoryCard({ suggestions }) {
  return (
    <Card className="flex flex-col overflow-hidden border-2 border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          Suggested Responses
          {suggestions.length > 0 && (
            <Badge variant="outline" className="ml-auto text-xs">
              {suggestions.length} suggestions
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-3">
            {suggestions.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No suggestions recorded</p>
                <p className="text-xs mt-1">Suggestions will appear when workflow data is saved</p>
              </div>
            ) : (
              suggestions.map((suggestion, idx) => (
                <div
                  key={suggestion.id || idx}
                  className="p-3 rounded-lg border-2 border-border bg-muted/30"
                >
                  {/* Context badge */}
                  <div className="flex items-center gap-2 mb-2">
                    <Badge 
                      variant="outline" 
                      className="text-[10px] bg-purple-500/10 text-purple-500 border-purple-500/50"
                    >
                      {suggestion.stageName}
                    </Badge>
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    <Badge 
                      variant="outline" 
                      className="text-[10px] bg-amber-500/10 text-amber-500 border-amber-500/50"
                    >
                      {suggestion.itemLabel}
                    </Badge>
                  </div>

                  {/* Suggestion text */}
                  <div className="flex items-start gap-2">
                    <Bot className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">
                        "{suggestion.text}"
                      </p>
                      
                      {/* Slot options badges */}
                      {suggestion.slotOptions && suggestion.slotOptions.length > 0 && (
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
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/**
 * Read-only Progress Bar
 */
function WorkflowProgressBarReadOnly({
  stages,
  itemStatuses,
  completionPercentage,
  completedItems,
  totalItems,
  isComplete,
}) {
  const skippedItems = Object.values(itemStatuses).filter(s => s.status === "skipped").length;

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
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
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
          <Progress value={completionPercentage} className="h-2" indicatorClassName="bg-green-500" />
        </div>

        {/* Stats */}
        <div className="flex items-center gap-3 shrink-0 text-sm">
          <span className="flex items-center gap-1 text-green-500">
            <CheckCircle className="h-3.5 w-3.5" />
            {completedItems}
          </span>
          {skippedItems > 0 && (
            <span className="flex items-center gap-1 text-amber-500">
              <SkipForward className="h-3.5 w-3.5" />
              {skippedItems}
            </span>
          )}
          <span className="text-muted-foreground">/ {totalItems}</span>
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
