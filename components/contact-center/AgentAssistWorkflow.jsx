"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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

  // Track suggestions for saving to history
  const [allSuggestions, setAllSuggestions] = useState([]);
  const suggestionsRef = useRef([]);
  const transcriptionsRef = useRef([]);

  // Keep refs updated for cleanup function
  useEffect(() => {
    suggestionsRef.current = allSuggestions;
  }, [allSuggestions]);

  useEffect(() => {
    transcriptionsRef.current = transcriptions;
  }, [transcriptions]);

  // Save workflow history when component unmounts (call ends)
  useEffect(() => {
    return () => {
      // Only save if we have a session and some data
      if (!session?.id) return;
      
      const currentTranscriptions = transcriptionsRef.current;
      const currentSuggestions = suggestionsRef.current;
      
      if (currentTranscriptions.length === 0 && currentSuggestions.length === 0) return;

      // Fire and forget - save history data
      fetch("/api/agent-assist/workflow/save-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
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
      }).catch(err => {
        console.error("[AgentAssistWorkflow] Failed to save history:", err);
      });
    };
  }, [session?.id]);

  // Callback for when suggestions change
  const handleSuggestionsChange = useCallback((suggestions) => {
    setAllSuggestions(suggestions);
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
      {/* 3 karty - równa szerokość, scrollable */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: Workflow Stages & Items */}
        <WorkflowStagesCard
          stages={stages}
          itemStatuses={itemStatuses}
          isAnalyzing={isAnalyzing}
          onCompleteItem={completeItem}
          onSkipItem={skipItem}
        />

        {/* Center: Live Transcription */}
        <LiveTranscriptionCard transcriptions={transcriptions} />

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
 * Workflow Stages Card with Accordions
 */
function WorkflowStagesCard({ stages, itemStatuses, isAnalyzing, onCompleteItem, onSkipItem }) {
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
                          const isAiFilled = status.auto_filled || status.confidence_score;

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
                                      <div className="flex items-center gap-1.5">
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
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-5 w-5 text-muted-foreground hover:text-foreground"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleStartEdit(item, slotValue);
                                          }}
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
                                
                                {/* Confidence score for non-slot items */}
                                {item.type !== "slot" && status.confidence_score && (
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
 * Generate a suggestion based on the item
 */
function generateSuggestion(stage, item) {
  // Generate contextual question based on item type and label
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
  
  // Find matching template or use default
  let text = templates.default;
  for (const [key, value] of Object.entries(templates)) {
    if (key !== "default" && labelLower.includes(key)) {
      text = value;
      break;
    }
  }

  // For select type slots, add options to the suggestion
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
  const scrollRef = useRef(null);
  const endRef = useRef(null);
  const lastItemIdRef = useRef(null);

  // Add new suggestion when currentSlot changes to a new item
  useEffect(() => {
    if (!currentSlot) return;
    
    const { stage, item } = currentSlot;
    
    // Only add suggestion if this is a new item
    if (lastItemIdRef.current !== item.id) {
      lastItemIdRef.current = item.id;
      const newSuggestion = generateSuggestion(stage, item);
      setSuggestions((prev) => {
        const updated = [...prev, newSuggestion];
        // Notify parent of suggestion change
        if (onSuggestionsChange) {
          onSuggestionsChange(updated);
        }
        return updated;
      });
    }
  }, [currentSlot, onSuggestionsChange]);

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
          {suggestions.length > 0 && (
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
