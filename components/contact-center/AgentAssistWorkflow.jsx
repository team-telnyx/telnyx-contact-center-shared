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
import useWorkflowStore, { useSlotsFilled } from "@/lib/stores/workflow-store";
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
  Activity,
  Target,
  Volume2,
  Languages,
} from "lucide-react";
import { notify } from "@/components/ToastNotify";
import { normalizeLanguageCode as normalizeBaseLanguageCode } from "@/lib/language-code-utils";
import { resolveSuggestedResponseTarget } from "@/lib/agent-assist/suggestion-target-resolver.mjs";
import { appendUniqueSuggestion } from "@/lib/agent-assist/suggestion-dedup.mjs";
import { findTranscriptIdForUtterance } from "@/lib/agent-assist/slot-utterance-match.mjs";

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
  const contactCenter = useActiveCallStore((state) => state.contactCenter);

  // AI Handoff polling timeout ref
  const aiPollTimeoutRef = useRef(null);
  const aiPollCountRef = useRef(0);
  const analyzedTranscriptionIdsRef = useRef(new Set());
  const AI_POLL_MAX_ATTEMPTS = 10; // 10 attempts * 3 seconds = 30 seconds
  const AI_POLL_INTERVAL_MS = 3000;

  // Check if interaction has ai_call_control_id (AI assisted call)
  const aiCallControlId = useMemo(() => {
    return interaction?.metadata?.ai_call_control_id || 
           interaction?.ai_call_control_id || 
           activeCall?.aiCallControlId ||
           contactCenter?.aiCallControlId ||
           null;
  }, [interaction, activeCall, contactCenter]);

  const assistConfig = interaction?.metadata?.agent_assist_config || {};
  const showSttConfidence = assistConfig.enable_stt_confidence !== false;
  const showLlmConfidence = assistConfig.enable_llm_confidence !== false;
  const translationEnabled =
    assistConfig.assist_type === "workflows" &&
    assistConfig.enable_translation === true;
  const interactionMetadata = {
    ...(interaction?.metadata || {}),
    ...(activeCall?.metadata || {}),
    ...(contactCenter?.metadata || {}),
  };
  const callerLanguage = normalizeBaseLanguageCode(interactionMetadata.caller_language, { fallback: null });
  const agentLanguage = normalizeBaseLanguageCode(interactionMetadata.agent_language, { fallback: null });

  const translationLanguages = useMemo(() => {
    if (!Array.isArray(transcriptions)) return null;
    const finalWithTranslation = transcriptions.filter(
      (t) => t?.isFinal && t?.translation?.text,
    );
    if (finalWithTranslation.length === 0) return null;
    const latest = finalWithTranslation[finalWithTranslation.length - 1];
    return {
      sourceLanguage:
        latest?.translation?.sourceLanguage ||
        latest?.translation?.detectedSourceLanguage ||
        null,
      targetLanguage: latest?.translation?.targetLanguage || null,
    };
  }, [transcriptions]);

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
          confidence: t.confidence,
          source: t.source,
          provider: t.provider,
          model: t.model,
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
    if (interaction?.metadata?.preview_only === true) return;

    fetchSession(interactionId).then((existingSession) => {
      if (!existingSession && workflowId) {
        startWorkflow(interactionId, workflowId).catch((err) => {
          console.error("[AgentAssistWorkflow] Failed to start workflow:", err);
        });
      }
    }).catch((err) => {
      console.error("[AgentAssistWorkflow] Failed to fetch session:", err);
    });
  }, [interactionId, workflowId, interaction?.metadata?.preview_only, fetchSession, startWorkflow]);

  // Analyze new transcriptions as they come in
  useEffect(() => {
    if (!session || transcriptions.length === 0) return;
    if (assistConfig.auto_detect_completion === false) return;

    const finalTranscriptionsToAnalyze = transcriptions.filter(
      (transcription) =>
        transcription?.isFinal &&
        transcription?.id &&
        !analyzedTranscriptionIdsRef.current.has(transcription.id)
    );
    if (finalTranscriptionsToAnalyze.length === 0) return;

    for (const transcription of finalTranscriptionsToAnalyze) {
      analyzedTranscriptionIdsRef.current.add(transcription.id);
    }

    const analyzeIfNew = async () => {
      for (const transcription of finalTranscriptionsToAnalyze) {
        try {
          await analyzeTranscript(
            transcription.transcript,
            transcription.track
          );
        } catch (err) {
          console.error("[AgentAssistWorkflow] Analysis error:", err);
        }
      }
    };

    const timer = setTimeout(analyzeIfNew, 500);
    return () => clearTimeout(timer);
  }, [session, transcriptions, analyzeTranscript, assistConfig.auto_detect_completion]);

  // Find the current slot that needs filling (for suggested response)
  // MUST be before any conditional returns to maintain hook order
  const slotsFilled = useSlotsFilled();

  const currentSuggestionTarget = useMemo(() => {
    return resolveSuggestedResponseTarget({
      stages,
      itemStatuses,
      slotsFilled,
      transcriptions,
    });
  }, [stages, itemStatuses, slotsFilled, transcriptions]);

  // Click slot -> jump transcript to exact utterance
  const [jumpTarget, setJumpTarget] = useState({ transcriptId: null, nonce: 0 });
  const requestJumpToUtterance = useCallback((sourceUtterance) => {
    const id = findTranscriptIdForUtterance(transcriptions, sourceUtterance);
    if (!id) {
      notify({
        title: "Transcript not found",
        description: "No matching utterance in the transcript yet",
        variant: "info",
      });
      return;
    }
    setJumpTarget((prev) => ({ transcriptId: id, nonce: prev.nonce + 1 }));
  }, [transcriptions]);

  // Loading state
  if (isLoading && !session) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-muted-foreground" />
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

      {translationEnabled && (
        <div className="shrink-0 mb-3">
          <TranslationIndicator
            sourceLanguage={callerLanguage || translationLanguages?.sourceLanguage}
            targetLanguage={agentLanguage || translationLanguages?.targetLanguage}
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
      <div className="flex gap-4 flex-1 min-h-0 min-w-0 overflow-hidden">
        {/* Left: Workflow Stages & Items */}
        <WorkflowStagesCard
          stages={stages}
          itemStatuses={itemStatuses}
          isAnalyzing={isAnalyzing}
          onCompleteItem={completeItem}
          onSkipItem={skipItem}
          aiSlotsDetails={aiHandoff.slotsDetails}
          slotsFilled={slotsFilled}
          showLlmConfidence={showLlmConfidence}
          showExpandedStages={assistConfig.show_expanded_stages === true}
          onJumpToUtterance={requestJumpToUtterance}
        />

        {/* Center: Live Transcription */}
        <LiveTranscriptionCard
          transcriptions={transcriptions}
          translationConfig={interaction?.metadata?.agent_assist_config || {}}
          interactionId={interactionId}
          showSttConfidence={showSttConfidence}
          jumpTarget={jumpTarget}
        />

        {/* Right: Suggested Response (single) */}
        <SuggestedResponseCard 
          currentSlot={currentSuggestionTarget} 
          onSuggestionsChange={handleSuggestionsChange}
          isAiAssisted={aiHandoff.isAiAssisted}
          aiDataReceived={aiHandoff.aiDataReceived}
          aiDataLoading={aiHandoff.aiDataLoading}
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
          slotsFilled={slotsFilled}
        />
      </div>
    </div>
  );
}

function normalizeLanguageCode(language) {
  if (!language) return null;
  return String(language).toLowerCase();
}

function getLanguageFlag(language) {
  const normalized = normalizeLanguageCode(language);
  if (!normalized) return "🌐";

  const full = normalized.replace("_", "-");
  const base = full.split("-")[0];

  switch (full) {
    case "en-gb":
      return "🇬🇧";
    case "pt-br":
      return "🇧🇷";
    case "pt-pt":
      return "🇵🇹";
    case "zh-cn":
    case "zh-hans":
      return "🇨🇳";
    case "zh-tw":
    case "zh-hant":
      return "🇹🇼";
    default:
      break;
  }

  switch (base) {
    case "en":
      return "🇺🇸";
    case "pl":
      return "🇵🇱";
    case "es":
      return "🇪🇸";
    case "fr":
      return "🇫🇷";
    case "de":
      return "🇩🇪";
    case "it":
      return "🇮🇹";
    case "pt":
      return "🇵🇹";
    case "uk":
      return "🇺🇦";
    case "ru":
      return "🇷🇺";
    case "ja":
      return "🇯🇵";
    case "zh":
      return "🇨🇳";
    case "ko":
      return "🇰🇷";
    case "ar":
      return "🇸🇦";
    case "hi":
      return "🇮🇳";
    default:
      return "🌐";
  }
}

function formatLanguageLabel(language) {
  if (!language) return "Detecting";
  const normalized = normalizeLanguageCode(language);
  if (normalized === "auto") return "Auto-detect";
  const baseLanguage = normalized?.replace("_", "-").split("-")[0];
  if (!baseLanguage) return "Detecting";

  const languageNames = {
    en: "English",
    pl: "Polish",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    uk: "Ukrainian",
    ru: "Russian",
    ja: "Japanese",
    zh: "Chinese",
    ko: "Korean",
    ar: "Arabic",
    hi: "Hindi",
  };

  return languageNames[baseLanguage] || baseLanguage.toUpperCase();
}

function TranslationIndicator({ sourceLanguage, targetLanguage }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-sky-500/30 bg-sky-500/5">
      <div className="p-2 rounded-lg bg-sky-500/10">
        <Languages className="h-5 w-5 text-sky-500" />
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Live Translation</span>
          <Badge variant="outline" className="text-xs text-muted-foreground">
            Transcription + TTS
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 min-w-0">
          <span className="flex items-center gap-1 min-w-0">
            {getLanguageFlag(sourceLanguage)}
            <span className="truncate">{formatLanguageLabel(sourceLanguage)}</span>
          </span>
          <span className="shrink-0">-</span>
          <span className="flex items-center gap-1 min-w-0">
            {getLanguageFlag(targetLanguage)}
            <span className="truncate">{formatLanguageLabel(targetLanguage)}</span>
          </span>
        </div>
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
    <div className="flex items-center gap-3 p-3 rounded-lg border border-violet-500/30 bg-violet-500/5">
      <div className="p-2 rounded-lg bg-violet-500/10">
        <Bot className="h-5 w-5 text-violet-500" />
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">AI Assisted Call</span>
          {isReceived ? (
            <Badge variant="outline" className="text-xs text-emerald-600 dark:text-emerald-400 border-emerald-500/40">
              <CheckCircle className="h-3 w-3 mr-1" />
              Data Received
            </Badge>
          ) : isLoading ? (
            <Badge variant="outline" className="text-xs text-muted-foreground">
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
      <Card className="border border-violet-500/30 bg-violet-500/5">
        <CollapsibleTrigger className="w-full">
          <CardHeader className="py-3 px-4 cursor-pointer hover:bg-violet-500/10 transition-colors">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/10">
                <Brain className="h-3.5 w-3.5 text-violet-500" />
              </span>
              AI Call Analysis
              <div className="flex items-center gap-2 ml-auto">
                {sentiment && (
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    {getSentimentEmoji()} Sentiment
                  </Badge>
                )}
                {summary && (
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    Summary
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
                    <MessageSquare className="h-4 w-4 text-sky-500" />
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
                    <Heart className="h-4 w-4 text-rose-500" />
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

function getItemStatusSnapshot(item, itemStatuses, slotsFilled) {
  const status = itemStatuses[item.id] || { status: "pending" };
  const slotValue = status.value || status.extracted_value || (item.slot_name ? slotsFilled[item.slot_name] : null);
  const confidenceScore = status.confidence_score;
  const confidenceThreshold = status.confidence_threshold ?? 0.95;
  const isSuggested = status.status === "suggested";
  const isCompleted = status.status === "completed" || isSlotFilledFromWorkflowState(item, slotsFilled);
  const needsConfirmation =
    isSuggested &&
    Boolean(slotValue) &&
    confidenceScore !== null &&
    confidenceScore !== undefined &&
    confidenceScore < confidenceThreshold;

  return { status, slotValue, isSuggested, isCompleted, needsConfirmation };
}

function getStageVerificationAlert(stage, itemStatuses, completedBlinkStageIds = new Set(), slotsFilled = {}) {
  const hasItemNeedingConfirmation = stage.items?.some((item) => (
    getItemStatusSnapshot(item, itemStatuses, slotsFilled).needsConfirmation
  ));

  if (hasItemNeedingConfirmation) {
    return {
      type: "needs-confirmation",
      label: "Needs review",
      className: "border-amber-500/60 bg-amber-500/5",
    };
  }

  if (completedBlinkStageIds.has(stage.id)) {
    return {
      type: "completed-recently",
      label: "Updated",
      className: "border-emerald-500/40 bg-emerald-500/5",
    };
  }

  return null;
}

/**
 * Workflow Stages Card with Accordions
 */
function WorkflowStagesCard({ stages, itemStatuses, isAnalyzing, onCompleteItem, onSkipItem, aiSlotsDetails = {}, slotsFilled = {}, showLlmConfidence = true, showExpandedStages = false, onJumpToUtterance }) {
  // Track which stage is expanded (user can manually toggle)
  const [expandedStage, setExpandedStage] = useState(null);
  const [expandedStages, setExpandedStages] = useState([]);
  const [completedBlinkStageIds, setCompletedBlinkStageIds] = useState(new Set());
  const previousItemSnapshotsRef = useRef(new Map());
  const itemRefs = useRef({});

  // Find currently active stage (first stage with incomplete items)
  const activeStageId = useMemo(() => {
    for (const stage of stages) {
      const hasIncomplete = stage.items?.some((item) => {
        const status = itemStatuses[item.id]?.status;
        if (status === "completed" || status === "skipped") return false;
        return !isSlotFilledFromWorkflowState(item, slotsFilled);
      });
      if (hasIncomplete) return stage.id;
    }
    return stages[stages.length - 1]?.id; // All complete - show last
  }, [stages, itemStatuses, slotsFilled]);

  // Auto-expand next section when current section completes, or all stages when configured
  useEffect(() => {
    if (showExpandedStages) {
      setExpandedStages(stages.map((stage) => stage.id));
      return;
    }

    if (!expandedStage || expandedStage === activeStageId) {
      setExpandedStage(activeStageId);
    }
  }, [activeStageId, expandedStage, showExpandedStages, stages]);

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

  useEffect(() => {
    const previousSnapshots = previousItemSnapshotsRef.current;
    const nextSnapshots = new Map();
    let changedItemId = null;
    let changedStageId = null;
    let changedItemCompleted = false;

    for (const stage of stages) {
      for (const item of stage.items || []) {
        const snapshot = getItemStatusSnapshot(item, itemStatuses, slotsFilled);
        const compactSnapshot = {
          status: snapshot.status.status || "pending",
          value: snapshot.slotValue || "",
          needsConfirmation: snapshot.needsConfirmation,
          isCompleted: snapshot.isCompleted,
        };
        const previousSnapshot = previousSnapshots.get(item.id);

        if (previousSnapshot) {
          const valueChanged = compactSnapshot.value && compactSnapshot.value !== previousSnapshot.value;
          const statusChanged = compactSnapshot.status !== previousSnapshot.status;
          const becameConfirmation = compactSnapshot.needsConfirmation && !previousSnapshot.needsConfirmation;
          const becameCompleted = compactSnapshot.isCompleted && !previousSnapshot.isCompleted;

          if (valueChanged || statusChanged || becameConfirmation || becameCompleted) {
            changedItemId = item.id;
            changedStageId = stage.id;
            changedItemCompleted = becameCompleted;
          }
        }

        nextSnapshots.set(item.id, compactSnapshot);
      }
    }

    previousItemSnapshotsRef.current = nextSnapshots;

    if (!changedItemId) return;

    setHighlightedItemId(changedItemId);

    if (showExpandedStages || changedStageId === expandedStage) {
      window.requestAnimationFrame(() => {
        itemRefs.current[changedItemId]?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }

    if (changedItemCompleted && changedStageId) {
      setCompletedBlinkStageIds((current) => new Set([...current, changedStageId]));
      const timer = setTimeout(() => {
        setCompletedBlinkStageIds((current) => {
          const next = new Set(current);
          next.delete(changedStageId);
          return next;
        });
      }, 1400);
      return () => clearTimeout(timer);
    }
  }, [itemStatuses, slotsFilled, stages, showExpandedStages, expandedStage]);

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

  const handleConfirmSuggestedSlot = (itemId, value) => {
    if (!value) return;
    onCompleteItem(itemId, value);
    setHighlightedItemId(itemId);
  };

  return (
    <Card className="flex-1 basis-0 min-w-0 flex flex-col overflow-hidden border border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-indigo-500/10">
            <ClipboardList className="h-3.5 w-3.5 text-indigo-500" />
          </span>
          Workflow Checklist
          {isAnalyzing && (
            <Badge variant="outline" className="ml-auto text-xs text-indigo-600 dark:text-indigo-400 border-indigo-500/40">
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
              type={showExpandedStages ? "multiple" : "single"}
              collapsible
              value={showExpandedStages ? expandedStages : expandedStage}
              onValueChange={showExpandedStages ? setExpandedStages : setExpandedStage}
              className="w-full"
            >
              {stages.map((stage, stageIndex) => {
                const stageCompletion = getStageCompletion(stage, itemStatuses, slotsFilled);
                const isActive = stage.id === activeStageId;
                const stageAlert = getStageVerificationAlert(stage, itemStatuses, completedBlinkStageIds);

                return (
                  <AccordionItem
                    key={stage.id}
                    value={stage.id}
                    className={`border-b-0 mb-2 rounded-lg border ${
                      stageAlert?.className
                        ? stageAlert.className
                        : isActive
                        ? "border-primary/40 bg-muted/30"
                        : stageCompletion.isComplete
                        ? "border-border bg-muted/20"
                        : "border-border"
                    }`}
                  >
                    <AccordionTrigger className="px-3 py-2 hover:no-underline">
                      <div className="flex items-center gap-2 flex-1">
                        <span className={`flex items-center justify-center w-5 h-5 rounded-full text-xs font-medium ${
                          stageCompletion.isComplete
                            ? "bg-emerald-600 text-white"
                            : isActive
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        }`}>
                          {stageCompletion.isComplete ? (
                            <CheckCircle className="h-3 w-3" />
                          ) : (
                            stageIndex + 1
                          )}
                        </span>
                        <span className="font-medium text-sm">{stage.name}</span>
                        {stageAlert && (
                          <Badge
                            variant="outline"
                            className={`text-xs ${
                              stageAlert.type === "needs-confirmation"
                                ? "text-amber-600 dark:text-amber-400 border-amber-500/50"
                                : stageAlert.type === "completed-recently"
                                ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                                : "bg-muted"
                            }`}
                          >
                            {stageAlert.label}
                          </Badge>
                        )}
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
                          const isCompleted = status.status === "completed" || isSlotFilledFromWorkflowState(item, slotsFilled);
                          const isSuggested = status.status === "suggested";
                          const isSkipped = status.status === "skipped";
                          const isHighlighted = item.id === highlightedItemId;
                          const isEditing = editingItemId === item.id;
                          const slotValue = status.value || status.extracted_value || (item.slot_name ? slotsFilled[item.slot_name] : null);
                          const completedBy = status.completed_by; // 'ai' | 'agent' | null
                          const confidenceScore = status.confidence_score;
                          const confidenceThreshold = status.confidence_threshold ?? 0.95;
                          const isLowConfidence = isSuggested && slotValue && confidenceScore !== null && confidenceScore !== undefined && confidenceScore < confidenceThreshold;
                          // Check AI slots details for additional context
                          const aiSlotInfo = item.slot_name ? aiSlotsDetails[item.slot_name] : null;
                          const isAiFilled = completedBy === "ai" || (aiSlotInfo?.value && !completedBy);
                          const isAgentFilled = completedBy === "agent";
                          // Source utterance used to jump to the matching transcript bubble
                          const sourceUtteranceForJump = status?.source_transcript || aiSlotInfo?.source_utterance || null;

                          return (
                            <div
                              key={item.id}
                              ref={(node) => {
                                if (node) {
                                  itemRefs.current[item.id] = node;
                                } else {
                                  delete itemRefs.current[item.id];
                                }
                              }}
                              data-workflow-item-id={item.id}
                              className={`flex items-start gap-2 p-2 rounded-md transition-all ${
                                isLowConfidence
                                  ? "bg-amber-500/10 border-l-2 border-amber-500"
                                  : isCompleted
                                  ? "bg-muted/40"
                                  : isSkipped
                                  ? "bg-muted/50 opacity-60"
                                  : isHighlighted
                                  ? "bg-muted/60 ring-1 ring-primary/40"
                                  : "hover:bg-muted/50"
                              }`}
                            >
                              <Checkbox
                                checked={isCompleted}
                                disabled={isCompleted || isSkipped || isLowConfidence}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    if (isSuggested && slotValue) {
                                      handleConfirmSuggestedSlot(item.id, slotValue);
                                      return;
                                    }
                                    onCompleteItem(item.id);
                                    setHighlightedItemId(item.id);
                                  }
                                }}
                                className={`mt-0.5 ${
                                  isCompleted ? "border-emerald-600 bg-emerald-600" : ""
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
                                        {sourceUtteranceForJump ? (
                                          <>
                                            <button
                                              type="button"
                                              title="Jump to transcript"
                                              className="text-sm font-medium truncate hover:underline cursor-pointer text-left"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                onJumpToUtterance?.(sourceUtteranceForJump);
                                              }}
                                            >
                                              {slotValue}
                                            </button>
                                            <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden="true" />
                                          </>
                                        ) : (
                                          <span className="text-sm font-medium text-foreground">
                                            {slotValue}
                                          </span>
                                        )}
                                        {/* Source indicator: AI or Agent */}
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
                                        {/* Confidence indicator for AI-filled slots */}
                                        {showLlmConfidence && isAiFilled && confidenceScore !== null && confidenceScore !== undefined && (
                                          <Badge
                                            variant="outline"
                                            className={`text-[10px] px-1.5 py-0 ${
                                              confidenceScore >= 0.7
                                                ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                                                : confidenceScore >= 0.5
                                                ? "text-amber-600 dark:text-amber-400 border-amber-500/40"
                                                : "text-amber-700 dark:text-amber-300 border-amber-500/60"
                                            }`}
                                            title={`LLM confidence: ${Math.round(confidenceScore * 100)}% (threshold ${Math.round(confidenceThreshold * 100)}%)`}
                                          >
                                            LLM {Math.round(confidenceScore * 100)}%
                                          </Badge>
                                        )}
                                        {isLowConfidence && Array.isArray(status.alternatives) && status.alternatives.length > 0 && (
                                          <div className="flex flex-col gap-1 w-full mt-1">
                                            {status.alternatives.map((alt, altIdx) => (
                                              <Button
                                                key={altIdx}
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                className="h-5 px-2 text-[10px] justify-start border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/15"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleConfirmSuggestedSlot(item.id, alt.value);
                                                }}
                                                title={`Use this alternative (${Math.round((alt.confidence ?? 0) * 100)}% confidence)`}
                                              >
                                                {alt.value}
                                                <span className="ml-1 text-amber-500/80">{Math.round((alt.confidence ?? 0) * 100)}%</span>
                                              </Button>
                                            ))}
                                          </div>
                                        )}
                                        {isLowConfidence && (
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-5 px-2 text-[10px] border-amber-500/60 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleConfirmSuggestedSlot(item.id, slotValue);
                                            }}
                                            title="Confirm this low-confidence LLM value"
                                          >
                                            <Check className="h-3 w-3 mr-1" />
                                            Confirm
                                          </Button>
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
                                    {showLlmConfidence && isAiFilled && confidenceScore !== null && confidenceScore !== undefined && (
                                      <Badge
                                        variant="outline"
                                        className={`text-xs ${
                                          confidenceScore >= 0.7
                                            ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                                            : confidenceScore >= 0.5
                                            ? "text-amber-600 dark:text-amber-400 border-amber-500/40"
                                            : "text-amber-700 dark:text-amber-300 border-amber-500/60"
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
 * Live Transcription Card with chat bubbles
 */
function LiveTranscriptionCard({ transcriptions, translationConfig, interactionId, showSttConfidence = true, jumpTarget }) {
  const scrollRef = useRef(null);
  const endRef = useRef(null);
  const bubbleRefs = useRef({});
  const [highlightedId, setHighlightedId] = useState(null);
  const highlightTimeoutRef = useRef(null);
  const rafIdRef = useRef(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptions]);

  // Jump to (and highlight) the transcript bubble matching a slot's source utterance
  useEffect(() => {
    if (!jumpTarget || !jumpTarget.transcriptId) return;
    const id = jumpTarget.transcriptId;
    const el = bubbleRefs.current[id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Radix ScrollArea viewport fallback: ensure the scroll container aligns too
      const viewport = el.closest("[data-radix-scroll-area-viewport]");
      if (viewport && typeof viewport.scrollTo === "function") {
        const elRect = el.getBoundingClientRect();
        const vpRect = viewport.getBoundingClientRect();
        const offset = elRect.top - vpRect.top - (vpRect.height - elRect.height) / 2;
        viewport.scrollTo({ top: viewport.scrollTop + offset, behavior: "smooth" });
      }
    }
    // Defer the highlight state set out of the synchronous effect body (react-hooks/set-state-in-effect).
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      setHighlightedId(id);
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
      highlightTimeoutRef.current = setTimeout(() => {
        setHighlightedId(null);
        highlightTimeoutRef.current = null;
      }, 2200);
    });
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
    };
  }, [jumpTarget]);

  return (
    <Card className="flex-1 basis-0 min-w-0 flex flex-col overflow-hidden border border-border">
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
        <ScrollArea className="h-full" ref={scrollRef}>
          <div className="p-4 space-y-3">
            {transcriptions.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Waiting for conversation...</p>
              </div>
            ) : (
              transcriptions.map((t) => (
                <div
                  key={t.id}
                  data-transcript-id={t.id}
                  ref={(node) => {
                    if (node) {
                      bubbleRefs.current[t.id] = node;
                    } else {
                      delete bubbleRefs.current[t.id];
                    }
                  }}
                >
                  <TranscriptionBubble
                    transcription={t}
                    translationConfig={translationConfig}
                    interactionId={interactionId}
                    showSttConfidence={showSttConfidence}
                    isHighlighted={highlightedId === t.id}
                  />
                </div>
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
function TranscriptionBubble({ transcription, translationConfig, interactionId, showSttConfidence = true, isHighlighted = false }) {
  const isCustomer = transcription.track === "inbound";
  const sentiment = transcription.sentiment;
  const sentimentScore = transcription.sentimentScore;
  const intent = transcription.intent;
  const sttConfidencePercent = formatSttConfidencePercent(transcription.confidence);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isInterim = !transcription.isFinal;

  const SentimentIcon = sentiment === "positive" ? Smile :
    sentiment === "negative" ? Frown : Meh;

  const sentimentBadgeClass = sentiment === "positive"
    ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
    : sentiment === "negative"
    ? "text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10"
    : "text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10";

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
      <div className={`flex items-center gap-1 mb-1 text-xs ${
        isCustomer ? "text-sky-600 dark:text-sky-400" : "text-emerald-600 dark:text-emerald-400 flex-row-reverse"
      }`}>
        {isCustomer ? (
          <User className="h-3 w-3" />
        ) : (
          <Headphones className="h-3 w-3" />
        )}
        <span className="font-medium">{isCustomer ? "Customer" : "Agent"}</span>
      </div>

      {/* Message bubble */}
      <div
        className={`max-w-[90%] rounded-xl px-3 py-2 border ${
          isCustomer
            ? "bg-sky-500/10 border-sky-500/20 rounded-tl-sm"
            : "bg-emerald-500/10 border-emerald-500/20 text-foreground rounded-tr-sm"
        } ${isInterim ? "opacity-70" : ""} ${isHighlighted ? "ring-2 ring-violet-500/60 bg-violet-500/5 transition-all" : ""}`}
      >
        <p className="text-sm leading-relaxed">{transcription.transcript}</p>
      </div>

      {/* Translation bubble */}
      {showTranslation && (
        <div className={`max-w-[90%] rounded-xl px-3 py-2 mt-1 border border-border bg-muted/40 text-foreground ${
          isCustomer ? "rounded-tl-sm" : "rounded-tr-sm"
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
          </div>
        </div>
      )}

      {/* Intent, sentiment, and STT confidence badges */}
      {(intent || sentiment || (showSttConfidence && sttConfidencePercent !== null)) && (
        <div className={`flex items-center gap-1.5 mt-1 ${
          isCustomer ? "" : "flex-row-reverse"
        }`}>
          {showSttConfidence && sttConfidencePercent !== null && (
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

function formatSttConfidencePercent(confidence) {
  if (confidence === null || confidence === undefined || confidence === "") return null;
  const numeric = typeof confidence === "number" ? confidence : Number(confidence);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.min(1, Math.max(0, numeric)) * 100);
}

/**
 * Generate a dynamic suggestion using LLM
 */
async function generateSuggestion(stage, item, session, transcriptions, { isAiAssisted = false, slotsFilled = {}, isFirstItem = false, targetMode = null, conversationContext = null, blockedItem = null, itemStatus = null } = {}) {
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
        itemPromptHint: item.prompt_hint,
        itemHints: Array.isArray(item.hints) ? item.hints : [],
        itemType: item.type,
        slotOptions: Array.isArray(item.slot_options) ? item.slot_options : null,
        workflowId: session?.workflow_id,
        agentName: session?.agent_name || "the agent",
        brandName: session?.brand_name,
        previousConversation,
        isAiAssisted,
        isFirstItem,
        prefilledSlots: slotsFilled,
        targetMode,
        conversationContext,
        itemStatus: itemStatus ? {
          status: itemStatus.status,
          extracted_value: itemStatus.extracted_value ?? itemStatus.value ?? null,
          value: itemStatus.value ?? itemStatus.extracted_value ?? null,
          confidence_score: itemStatus.confidence_score ?? null,
          confidence_threshold: itemStatus.confidence_threshold ?? null,
        } : null,
        blockedItem: blockedItem ? {
          id: blockedItem.id,
          label: blockedItem.label,
          type: blockedItem.type,
          slotName: blockedItem.slot_name || null,
        } : null,
      }),
    });

    if (!res.ok) {
      console.error("[generateSuggestion] API error:", res.status);
      // Fallback to static template
      return generateStaticSuggestion(stage, item, session?.agent_name);
    }

    const data = await res.json();
    if (!data.suggestion) {
      return generateStaticSuggestion(stage, item, session?.agent_name);
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
      targetMode,
      reason: conversationContext?.reason || null,
      blockedItemLabel: blockedItem?.label || null,
    };
  } catch (error) {
    console.error("[generateSuggestion] Error:", error);
    return generateStaticSuggestion(stage, item, session?.agent_name);
  }
}

/**
 * Fallback: Generate a static suggestion (when API fails)
 */
function generateStaticSuggestion(stage, item, agentName = null) {
  const introMatch = String(item.label || "").match(/introduce (?:yourself|your self)(?: as)?\s+(.+?)$/i);
  if (introMatch) {
    const identity = getHumanAgentIntroIdentity({
      labelIdentity: introMatch[1],
      promptHint: item.prompt_hint,
      agentName,
    });
    return {
      id: `${item.id}-${Date.now()}`,
      text: `Hello, I'm ${identity}. I'll be helping you today.`,
      stageName: stage.name,
      itemId: item.id,
      itemLabel: item.label,
      itemType: item.type,
      slotOptions: null,
      timestamp: new Date(),
    };
  }

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

function getHumanAgentIntroIdentity({ labelIdentity, promptHint, agentName }) {
  const finalAgentName = agentName && agentName !== "the agent" ? agentName : null;
  const rawIdentity = String(labelIdentity || "").trim().replace(/[.!?]+$/, "");
  const brandFromIdentity = rawIdentity.match(/\bfrom\s+(.+)$/i)?.[1]?.trim();
  const brandFromHint = String(promptHint || "").match(/\bat\s+([A-Z][\p{L}\p{N}& '-]+)/u)?.[1]?.trim();
  const brand = brandFromIdentity || brandFromHint;
  if (brand && finalAgentName) {
    return `${finalAgentName} from ${brand}`;
  }
  if (rawIdentity.includes("{{agent_name}}") && finalAgentName) {
    return rawIdentity.replace(/\{\{agent_name\}\}/gi, finalAgentName);
  }
  return rawIdentity || finalAgentName || "your support agent";
}

/**
 * Suggested Response Card - Accumulating list of suggestions
 */
function SuggestedResponseCard({ currentSlot, onSuggestionsChange, isAiAssisted, aiDataReceived, aiDataLoading }) {
  const [suggestions, setSuggestions] = useState([]);
  const [copiedId, setCopiedId] = useState(null);
  const [generatingSuggestion, setGeneratingSuggestion] = useState(false);
  const scrollRef = useRef(null);
  const endRef = useRef(null);
  // Set of target keys already generated this session. Using a set (not a single
  // last-key ref) prevents the same guide being appended twice when the resolved
  // target oscillates back to a previously-suggested one (A -> B -> A).
  const generatedTargetKeysRef = useRef(new Set());
  const prevAiDataReceivedRef = useRef(false);
  // Track whether the handoff greeting has already been sent (or is in-flight)
  // to avoid race condition where suggestions.length===0 still sees 0 mid-flight
  const handoffGreetingSentRef = useRef(false);
  
  // Get session and transcriptions from stores
  const session = useWorkflowStore((state) => state.session);
  const slotsFilled = useWorkflowStore((state) => state.slotsFilled);
  const transcriptions = useActiveCallStore((state) => state.transcriptions);

  // Fix 2: When AI handoff data arrives mid-session (race condition), reset suggestions
  // so agent only sees suggestions relevant to the first UNFILLED slot,
  // not suggestions generated before AI data arrived for already-filled slots.
  useEffect(() => {
    if (isAiAssisted && aiDataReceived && !prevAiDataReceivedRef.current) {
      prevAiDataReceivedRef.current = true;
      setSuggestions([]);
      generatedTargetKeysRef.current.clear(); // force regeneration for the new currentSlot
      handoffGreetingSentRef.current = false; // reset handoff greeting flag on AI data arrival
      if (onSuggestionsChange) onSuggestionsChange([]);
    }
  }, [isAiAssisted, aiDataReceived, onSuggestionsChange]);

  // Add new suggestion when currentSlot changes to a new item.
  // Fix 3: On AI-assisted calls, defer suggestion generation until AI data is received
  // to avoid generating suggestions for slots AI may have already filled.
  useEffect(() => {
    if (!currentSlot) return;

    // Fix 3: Wait for AI context before generating first suggestion on AI-assisted calls
    if (isAiAssisted && aiDataLoading) return;
    
    const { stage, item, targetMode, conversationContext, blockedItem, itemStatus } = currentSlot;
    const targetKey = [
      item.id,
      targetMode || "default",
      blockedItem?.id || "none",
      conversationContext?.matchedItemId || "none",
      conversationContext?.reason || "none",
      itemStatus?.extracted_value ?? itemStatus?.value ?? "none",
    ].join(":");
    
    // Only generate for a target key we haven't already generated for. A set
    // (rather than just the previous key) is what prevents duplicate guides when
    // the resolved target oscillates back to a previously-suggested one.
    if (!generatedTargetKeysRef.current.has(targetKey)) {
      generatedTargetKeysRef.current.add(targetKey);
      
      // Generate suggestion asynchronously
      // Mark handoff greeting as sent immediately (before async) to prevent
      // race condition where concurrent calls see isFirstItem=true multiple times
      const isFirstItem = isAiAssisted && !handoffGreetingSentRef.current;
      if (isFirstItem) handoffGreetingSentRef.current = true;
      setGeneratingSuggestion(true);
      generateSuggestion(stage, item, session, transcriptions, {
        isAiAssisted,
        slotsFilled,
        isFirstItem,
        targetMode,
        conversationContext,
        blockedItem,
        itemStatus,
      })
        .then((newSuggestion) => {
          if (!newSuggestion) return;
          setSuggestions((prev) => {
            // appendUniqueSuggestion returns the same reference when the guide is
            // a duplicate, so identical guidance never renders twice even if two
            // distinct target keys produce the same text.
            const updated = appendUniqueSuggestion(prev, newSuggestion);
            // Notify parent only when a new (non-duplicate) suggestion was added.
            if (updated !== prev && onSuggestionsChange) {
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
  }, [currentSlot, session, transcriptions, onSuggestionsChange, isAiAssisted, aiDataLoading, slotsFilled]);

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
    <Card className="flex-1 basis-0 min-w-0 flex flex-col overflow-hidden border border-border">
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/10">
            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
          </span>
          Suggested Responses
          {generatingSuggestion && (
            <Badge variant="outline" className="ml-auto text-xs text-violet-600 dark:text-violet-400 border-violet-500/40">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Generating...
            </Badge>
          )}
          {!generatingSuggestion && suggestions.length > 0 && (
            <Badge variant="outline" className="ml-auto text-xs text-violet-600 dark:text-violet-400 border-violet-500/40">
              {suggestions.length} suggestions
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
        <ScrollArea className="h-full overflow-x-hidden" ref={scrollRef}>
          <div className="px-3 py-3 space-y-3 max-w-full min-w-0 overflow-x-hidden">
            {/* Fix 3: Show waiting state while AI data loads on AI-assisted calls */}
            {suggestions.length === 0 && isAiAssisted && aiDataLoading ? (
              <div className="text-center text-muted-foreground py-8">
                <Loader2 className="h-8 w-8 mx-auto mb-2 opacity-40 animate-spin" />
                <p className="text-sm font-medium">Waiting for AI context...</p>
                <p className="text-xs mt-1">Suggestions will appear after AI data is received</p>
              </div>
            ) : suggestions.length === 0 ? (
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
                      className={`group w-full max-w-full min-w-0 box-border overflow-hidden p-3 rounded-lg border transition-all cursor-pointer ${
                        isLatest
                          ? "border-violet-500/40 bg-violet-500/5 hover:border-violet-500/60 hover:bg-violet-500/10"
                          : "border-border/50 bg-muted/20 hover:border-border hover:bg-muted/40"
                      }`}
                      onClick={() => handleCopy(suggestion)}
                    >
                      {/* Context badge */}
                      <div className="flex flex-wrap items-center gap-1.5 mb-2 min-w-0 max-w-full overflow-hidden">
                        <Badge 
                          variant="outline" 
                          className={`text-[10px] max-w-full min-w-0 overflow-hidden truncate ${
                            isLatest 
                              ? "text-foreground border-border"
                              : "text-muted-foreground"
                          }`}
                        >
                          <span className="truncate">{suggestion.stageName}</span>
                        </Badge>
                        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <Badge 
                          variant="outline" 
                          className={`text-[10px] max-w-full min-w-0 overflow-hidden truncate ${
                            isLatest
                              ? "text-foreground border-border"
                              : "text-muted-foreground"
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
                          {suggestion.slotOptions && (
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
                })}

                {/* Completion message */}
                {isComplete && (
                  <div className="text-center text-muted-foreground py-4 border-t">
                    <CheckCircle className="h-6 w-6 mx-auto mb-2 text-emerald-600 dark:text-emerald-400" />
                    <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">All items completed!</p>
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
  slotsFilled = {},
}) {
  // Calculate percentage from items if not provided
  const displayPercentage = completionPercentage ?? 
    (totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0);

  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-center gap-4">
        {/* Stage indicators */}
        <div className="flex items-center gap-1 shrink-0">
          {stages.map((stage, index) => {
            const completion = getStageCompletion(stage, itemStatuses, slotsFilled);
            return (
              <div
                key={stage.id}
                className={`flex items-center ${index < stages.length - 1 ? "gap-1" : ""}`}
                title={`${stage.name}: ${completion.completed}/${completion.total}`}
              >
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-all ${
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
          <Progress
            value={displayPercentage}
            className="h-2"
            indicatorClassName="bg-emerald-600"
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
                ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                : "text-foreground"
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
function isSlotFilledFromWorkflowState(item, slotsFilled = {}) {
  if (item?.type !== "slot" || !item.slot_name) return false;
  const value = slotsFilled[item.slot_name];
  return value !== undefined && value !== null && value !== "";
}

function getStageCompletion(stage, itemStatuses, slotsFilled = {}) {
  if (!stage?.items) return { completed: 0, total: 0, isComplete: false };

  const total = stage.items.length;
  const completed = stage.items.filter((item) => {
    const status = itemStatuses[item.id];
    return status?.status === "completed" || isSlotFilledFromWorkflowState(item, slotsFilled);
  }).length;

  return {
    completed,
    total,
    isComplete: completed === total && total > 0,
  };
}

export default AgentAssistWorkflow;
