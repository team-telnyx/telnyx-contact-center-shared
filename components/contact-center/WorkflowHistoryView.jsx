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
  Activity,
  Target,
  Copy,
  CheckCheck,
  Pencil,
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
          // Get transcriptions from metadata or from item statuses as fallback
          let transcriptions = agentAssist.transcriptions || [];
          
          // If no transcriptions in metadata, try to reconstruct from item statuses
          if (transcriptions.length === 0 && sessionData.session.stages) {
            const reconstructed = [];
            let seenTranscripts = new Set();
            
            sessionData.session.stages.forEach(stage => {
              stage.items?.forEach(item => {
                const status = item.status;
                if (status?.source_transcript && !seenTranscripts.has(status.source_transcript)) {
                  seenTranscripts.add(status.source_transcript);
                  reconstructed.push({
                    id: `reconstructed-${reconstructed.length}`,
                    transcript: status.source_transcript,
                    track: status.completed_by === 'customer' ? 'inbound' : 'outbound',
                    isFinal: true,
                  });
                }
              });
            });
            
            if (reconstructed.length > 0) {
              transcriptions = reconstructed;
            }
          }
          
          sessionData.session.transcriptions = transcriptions;
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
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-violet-500" />
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
      <div className="grid grid-cols-3 gap-4 h-[600px]">
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
    <Card className="flex flex-col overflow-hidden border border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-indigo-500/10">
            <ClipboardList className="h-3.5 w-3.5 text-indigo-500" />
          </span>
          Workflow Checklist
          {workflowName && (
            <Badge variant="outline" className="ml-auto text-xs text-indigo-600 dark:text-indigo-400 border-indigo-500/40">
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
                        ? "border-border bg-muted/20"
                        : "border-border"
                    }`}
                  >
                    <AccordionTrigger className="px-3 py-2 hover:no-underline">
                      <div className="flex items-center gap-2 flex-1">
                        <span className={`flex items-center justify-center w-5 h-5 rounded-full text-xs font-medium ${
                          stageCompletion.isComplete
                            ? "bg-emerald-600 text-white"
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
                              ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                              : "text-muted-foreground"
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
                          const completedBy = status.completed_by; // 'ai' | 'agent' | null
                          const confidenceScore = status.confidence_score;
                          const isAiFilled = completedBy === "ai" || (status.auto_filled && !completedBy) || (confidenceScore != null && !completedBy);
                          const isAgentFilled = completedBy === "agent";

                          return (
                            <div
                              key={item.id}
                              className={`flex items-start gap-2 p-2 rounded-md ${
                                isCompleted
                                  ? "bg-muted/40"
                                  : isSkipped
                                  ? "bg-muted/50 opacity-60"
                                  : "bg-muted/30"
                              }`}
                            >
                              <div className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center ${
                                isCompleted
                                  ? "border-emerald-600 bg-emerald-600"
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

                                {/* Slot value display (read-only) */}
                                {item.type === "slot" && (
                                  <div className="mt-1.5">
                                    {slotValue ? (
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-sm font-medium text-foreground">
                                          {slotValue}
                                        </span>
                                        {isAiFilled ? (
                                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-violet-600 dark:text-violet-400 border-violet-500/40 bg-violet-500/10" title="Filled by AI Assistant">
                                            <Bot className="h-3 w-3 mr-0.5" />
                                            AI
                                          </Badge>
                                        ) : isAgentFilled ? (
                                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-sky-600 dark:text-sky-400 border-sky-500/40 bg-sky-500/10" title="Filled by Agent">
                                            <User className="h-3 w-3 mr-0.5" />
                                            Agent
                                          </Badge>
                                        ) : null}
                                        {isAiFilled && confidenceScore != null && (
                                          <Badge
                                            variant="outline"
                                            className={`text-[10px] px-1.5 py-0 ${
                                              confidenceScore >= 0.7
                                                ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                                                : "text-amber-600 dark:text-amber-400 border-amber-500/40"
                                            }`}
                                            title={`LLM confidence: ${Math.round(confidenceScore * 100)}%`}
                                          >
                                            LLM {Math.round(confidenceScore * 100)}%
                                          </Badge>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                        <Pencil className="h-3 w-3" />
                                        No value captured
                                      </span>
                                    )}
                                  </div>
                                )}

                                {/* Source and confidence for non-slot completed items */}
                                {item.type !== "slot" && isCompleted && (isAiFilled || isAgentFilled || confidenceScore != null) && (
                                  <div className="flex items-center gap-1.5 mt-1">
                                    {isAiFilled ? (
                                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-violet-600 dark:text-violet-400 border-violet-500/40 bg-violet-500/10" title="Completed by AI Assistant">
                                        <Bot className="h-3 w-3 mr-0.5" />
                                        AI
                                      </Badge>
                                    ) : isAgentFilled ? (
                                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-sky-600 dark:text-sky-400 border-sky-500/40 bg-sky-500/10" title="Completed by Agent">
                                        <User className="h-3 w-3 mr-0.5" />
                                        Agent
                                      </Badge>
                                    ) : null}
                                    {isAiFilled && confidenceScore != null && (
                                      <Badge
                                        variant="outline"
                                        className={`text-xs ${
                                          confidenceScore >= 0.7
                                            ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                                            : "text-amber-600 dark:text-amber-400 border-amber-500/40"
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
    action: { color: "text-muted-foreground border-border", label: "Action" },
    question: { color: "text-muted-foreground border-border", label: "Question" },
    topic: { color: "text-muted-foreground border-border", label: "Topic" },
    slot: { color: "text-sky-700 dark:text-sky-300 border-sky-500/40", label: "Data" },
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
    <Card className="flex flex-col overflow-hidden border border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sky-500/10">
            <MessageSquare className="h-3.5 w-3.5 text-sky-500" />
          </span>
          Live Transcription
          {transcriptions.length > 0 && (
            <Badge variant="outline" className="ml-auto text-xs text-sky-600 dark:text-sky-400 border-sky-500/40">
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
function formatSttConfidencePercent(confidence) {
  if (confidence === null || confidence === undefined || confidence === "") return null;
  const numeric = typeof confidence === "number" ? confidence : Number(confidence);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.min(1, Math.max(0, numeric)) * 100);
}

function TranscriptionBubbleReadOnly({ transcription }) {
  const isCustomer = transcription.track === "inbound";
  const sentiment = transcription.sentiment;
  const sentimentScore = transcription.sentimentScore;
  const intent = transcription.intent;
  const sttConfidencePercent = formatSttConfidencePercent(transcription.confidence);

  const SentimentIcon = sentiment === "positive" ? Smile :
    sentiment === "negative" ? Frown : Meh;

  const sentimentBadgeClass = sentiment === "positive"
    ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
    : sentiment === "negative"
    ? "text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10"
    : "text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10";

  return (
    <div className={`flex flex-col ${isCustomer ? "items-start" : "items-end"}`}>
      {/* Speaker label */}
      <div className={`flex items-center gap-1 mb-1 text-xs ${
        isCustomer ? "text-sky-600 dark:text-sky-400" : "text-emerald-600 dark:text-emerald-400 flex-row-reverse"
      }`}>
        {isCustomer ? <User className="h-3 w-3" /> : <Headphones className="h-3 w-3" />}
        <span className="font-medium">{isCustomer ? "Customer" : "Agent"}</span>
      </div>

      {/* Message bubble */}
      <div className={`max-w-[90%] rounded-xl px-3 py-2 border ${
        isCustomer
          ? "bg-sky-500/10 border-sky-500/20 rounded-tl-sm"
          : "bg-emerald-500/10 border-emerald-500/20 text-foreground rounded-tr-sm"
      }`}>
        <p className="text-sm leading-relaxed">{transcription.transcript}</p>
      </div>

      {/* Intent, sentiment, and STT confidence badges */}
      {(intent || sentiment || sttConfidencePercent !== null) && (
        <div className={`flex items-center gap-1.5 mt-1 ${
          isCustomer ? "" : "flex-row-reverse"
        }`}>
          {sttConfidencePercent !== null && (
            <Badge
              variant="outline"
              className="text-[10px] text-muted-foreground"
              title="Speech-to-text recognition confidence from Telnyx Standalone STT"
            >
              <Activity className="h-3 w-3 mr-1" />
              STT {sttConfidencePercent}%
            </Badge>
          )}
          {intent && (
            <Badge variant="outline" className="text-[10px] text-violet-600 dark:text-violet-400 border-violet-500/40">
              <Target className="h-3 w-3 mr-1" />
              {intent}
            </Badge>
          )}
          {sentiment && (
            <Badge variant="outline" className={`text-[10px] capitalize ${sentimentBadgeClass}`}>
              <SentimentIcon className="h-3 w-3 mr-1" />
              {sentiment}
              {typeof sentimentScore === "number" && (
                <span className="ml-1">{sentimentScore}</span>
              )}
            </Badge>
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
  const [copiedId, setCopiedId] = useState(null);

  const handleCopy = (suggestion, idx) => {
    const key = suggestion.id || idx;
    try {
      navigator.clipboard?.writeText(suggestion.text);
      setCopiedId(key);
      setTimeout(() => setCopiedId((cur) => (cur === key ? null : cur)), 2000);
    } catch {}
  };

  return (
    <Card className="flex flex-col overflow-hidden border border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/10">
            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
          </span>
          Suggested Responses
          {suggestions.length > 0 && (
            <Badge variant="outline" className="ml-auto text-xs text-violet-600 dark:text-violet-400 border-violet-500/40">
              {suggestions.length} suggestions
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
        <ScrollArea className="h-full overflow-x-hidden">
          <div className="px-3 py-3 space-y-3 max-w-full min-w-0 overflow-x-hidden">
            {suggestions.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No suggestions recorded</p>
                <p className="text-xs mt-1">Suggestions will appear when workflow data is saved</p>
              </div>
            ) : (
              suggestions.map((suggestion, idx) => {
                const key = suggestion.id || idx;
                const isCopied = copiedId === key;
                const isLatest = idx === suggestions.length - 1;

                return (
                  <div
                    key={key}
                    className={`group w-full max-w-full min-w-0 box-border overflow-hidden p-3 rounded-lg border transition-all cursor-pointer ${
                      isLatest
                        ? "border-violet-500/40 bg-violet-500/5 hover:border-violet-500/60 hover:bg-violet-500/10"
                        : "border-border/50 bg-muted/20 hover:border-border hover:bg-muted/40"
                    }`}
                    onClick={() => handleCopy(suggestion, idx)}
                  >
                    {/* Context badge */}
                    <div className="flex flex-wrap items-center gap-1.5 mb-2 min-w-0 max-w-full overflow-hidden">
                      <Badge
                        variant="outline"
                        className={`text-[10px] max-w-full min-w-0 overflow-hidden truncate ${
                          isLatest ? "text-foreground border-border" : "text-muted-foreground"
                        }`}
                      >
                        <span className="truncate">{suggestion.stageName}</span>
                      </Badge>
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <Badge
                        variant="outline"
                        className={`text-[10px] max-w-full min-w-0 overflow-hidden truncate ${
                          isLatest ? "text-foreground border-border" : "text-muted-foreground"
                        }`}
                      >
                        <span className="truncate">{suggestion.itemLabel}</span>
                      </Badge>
                      {isLatest && (
                        <Badge variant="outline" className="text-[10px] text-violet-600 dark:text-violet-400 border-violet-500/50 bg-violet-500/10 shrink-0">
                          Current
                        </Badge>
                      )}
                    </div>

                    {/* Suggestion text */}
                    <div className="flex items-start gap-2">
                      <Bot className={`h-4 w-4 mt-0.5 shrink-0 ${
                        isLatest ? "text-violet-500" : "text-muted-foreground"
                      }`} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm leading-relaxed whitespace-pre-wrap break-words ${
                          isLatest ? "font-medium" : "text-muted-foreground"
                        }`}>
                          "{suggestion.text}"
                        </p>

                        {/* Slot options badges */}
                        {suggestion.slotOptions && suggestion.slotOptions.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {suggestion.slotOptions.map((opt) => (
                              <Badge
                                key={opt}
                                variant="outline"
                                className="text-[10px] text-muted-foreground"
                              >
                                {opt}
                              </Badge>
                            ))}
                          </div>
                        )}

                        <div className="flex items-center gap-2 mt-2">
                          <span className={`text-xs flex items-center gap-1 ${
                            isCopied
                              ? "text-emerald-600 dark:text-emerald-400"
                              : isLatest
                                ? "text-muted-foreground group-hover:text-foreground"
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
              })
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
    <div className="bg-card border border-border rounded-lg p-3">
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
                      ? "bg-emerald-600 text-white"
                      : completion.completed > 0
                      ? "bg-primary/60 text-primary-foreground"
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
          <Progress value={completionPercentage} className="h-2" indicatorClassName="bg-emerald-600" />
        </div>

        {/* Stats */}
        <div className="flex items-center gap-3 shrink-0 text-sm">
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="h-3.5 w-3.5" />
            {completedItems}
          </span>
          {skippedItems > 0 && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <SkipForward className="h-3.5 w-3.5" />
              {skippedItems}
            </span>
          )}
          <span className="text-muted-foreground">/ {totalItems}</span>
          <Badge
            variant="outline"
            className={`text-sm font-bold ${
              isComplete
                ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                : "text-foreground border-border"
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
