"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import { AdminPageContent, AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
// Same Telnyx model picker as Admin → AI Copilot.
import AIModels from "@/components/assistants/AIModels";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  IconArrowLeft,
  IconPlayerPlay,
  IconPlayerStop,
  IconMessageCircle,
  IconPhone,
  IconRobot,
  IconUser,
  IconLoader2,
  IconSend,
  IconVolume,
  IconVolumeOff,
  IconMicrophone,
  IconMicrophoneOff,
  IconRefresh,
  IconCheck,
  IconX,
  IconAlertCircle,
  IconCircleCheck,
  IconChevronRight,
  IconClipboardList,
  IconSettings,
  IconPencil,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { cn } from "@/lib/utils";
// Sequential, never-cancelled slot analysis shared by the chat and voice
// channels (the internal documentation, 5.3).
import { createTestAnalysisQueue } from "@/lib/agent-assist/test-analysis-queue.mjs";
import { hasSlotValue } from "@/lib/agent-assist/slot-display.mjs";
// Voice channel: the same authenticated Telnyx conversation WebSocket client
// and relay as the assistant configurator's Call button. The turn engine turns
// the documented Telnyx events into caller turns; the PCM helpers pace TTS
// audio into the socket as the simulated caller's voice.
import { TelnyxAvatarClient } from "@/lib/ai/telnyx-avatar-client.mjs";
import { createVoiceTestEngine } from "@/lib/ai/workflow-voice-test-engine.mjs";
import { decodeToPcm16Mono, buildInjection, createPacedSender, createSilenceStreamer } from "@/lib/ai/pcm16-injection.mjs";
// Shared, client-safe persona + Expressive Mode helpers. Same source of truth as
// the Call Generator's "Workflow Testing" action, so the simulated caller behaves
// identically here and in real call-flow workflow testing.
import {
  WORKFLOW_TESTING_PERSONAS,
  normalizePersona,
  voiceSupportsExpressive,
  applyVoiceExpression,
} from "@/lib/call-generator/persona-expression.mjs";

// TTS options will be loaded dynamically from API

/** Generate unique message ID to avoid React key collisions and doubled rendering */
function uniqueMessageId(prefix = "msg") {
  return `${prefix}-${crypto.randomUUID()}`;
}

// All test responses are generated dynamically via LLM based on AI assistant's messages

/**
 * Find the scenario step that best matches the last AI message.
 * Uses keyword matching (same as processAIResponse) - finds the first step whose
 * keywords appear in the AI's message, so the response is relevant to what the AI asked.
 * Also considers workflow state: prefers steps that correspond to pending workflow items.
 */
// Helper: get stage completion from item statuses
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

// Analyze a single conversation line for workflow item completion (same LLM
// as the live agent desktop). `job` comes from the test analysis queue and
// carries the preceding lines as `recentContext`, which the analyzer needs to
// attribute bare answers ("Around 85 euros") to the agent's question.
async function analyzeWorkflowMessage(workflowId, job, model) {
  const res = await fetch(`/api/admin/workflows/${workflowId}/analyze-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    signal: job.signal,
    body: JSON.stringify({
      transcript: job.transcript,
      speaker: job.speaker,
      itemStatuses: job.itemStatuses,
      slotsFilled: job.slotsFilled,
      recentContext: job.recentContext,
      // Per-test model chosen in the Model pickers (omitted = default chain).
      ...(model ? { model } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Analysis failed");
  return data;
}

// Workflow agent view - stages in accordions, crossed out when complete
function WorkflowAgentView({ stages, itemStatuses }) {
  const tUi = useUiText();
  const [expandedStage, setExpandedStage] = useState(null);
  const activeStageId = useMemo(() => {
    for (const stage of stages || []) {
      const hasIncomplete = stage.items?.some((item) => {
        const status = itemStatuses[item.id]?.status;
        return status !== "completed" && status !== "skipped";
      });
      if (hasIncomplete) return stage.id;
    }
    return stages?.[stages.length - 1]?.id;
  }, [stages, itemStatuses]);

  // When active stage changes (e.g. current stage completed), collapse the old and expand the next
  useEffect(() => {
    if (activeStageId) {
      setExpandedStage(activeStageId);
    }
  }, [activeStageId]);

  if (!stages?.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center py-12 text-muted-foreground">
        <IconClipboardList className="size-12 opacity-30 mb-4" />
        <p className="text-sm">{tUi("No workflow stages")}</p>
        <p className="text-xs mt-1">{tUi("Configure stages in the workflow editor")}</p>
      </div>
    );
  }

  return (
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
                className={cn(
                  "border-b-0 mb-2 rounded-lg border",
                  isActive && "border-purple-500/50 bg-purple-500/5",
                  stageCompletion.isComplete && "border-green-500/50 bg-green-500/5",
                  !isActive && !stageCompletion.isComplete && "border-border"
                )}
              >
                <AccordionTrigger className="px-3 py-2 hover:no-underline">
                  <div className="flex items-center gap-2 flex-1">
                    <span
                      className={cn(
                        "flex items-center justify-center w-5 h-5 rounded-full text-xs font-medium",
                        stageCompletion.isComplete && "bg-green-500 text-white",
                        isActive && "bg-purple-500 text-white",
                        !stageCompletion.isComplete && !isActive && "bg-muted text-muted-foreground"
                      )}
                    >
                      {stageCompletion.isComplete ? (
                        <IconCircleCheck className="size-3" />
                      ) : (
                        stageIndex + 1
                      )}
                    </span>
                    <span className="font-medium text-sm">{stage.name}</span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "ml-auto text-xs",
                        stageCompletion.isComplete &&
                          "bg-green-500/10 text-green-500 border-green-500/50",
                        !stageCompletion.isComplete && "bg-muted"
                      )}
                    >
                      {stageCompletion.completed}/{stageCompletion.total}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-3 pb-3">
                  <div className="space-y-1.5 pt-1">
                    {stage.items?.map((item) => {
                      const status = itemStatuses[item.id] || {
                        status: "pending",
                      };
                      const isCompleted = status.status === "completed";
                      // Below-threshold extraction: shown in amber with its
                      // confidence (agent desktop semantics) but not counted as
                      // completed anywhere.
                      const isSuggested = status.status === "suggested";
                      const slotValue = hasSlotValue(status.value)
                        ? status.value
                        : status.extracted_value;
                      const confidencePercent =
                        typeof status.confidence_score === "number"
                          ? Math.round(status.confidence_score * 100)
                          : null;
                      return (
                        <div
                          key={item.id}
                          data-workflow-item-status={status.status || "pending"}
                          className={cn(
                            "flex items-start gap-2 p-2 rounded-md",
                            isCompleted && "bg-green-500/10",
                            isSuggested && "bg-amber-500/10 border-l-2 border-amber-500",
                            !isCompleted && !isSuggested && "hover:bg-muted/50"
                          )}
                        >
                          <span className="mt-0.5">
                            {isCompleted ? (
                              <IconCircleCheck className="size-4 text-green-500 shrink-0" />
                            ) : isSuggested ? (
                              <IconAlertCircle className="size-4 text-amber-500 shrink-0" />
                            ) : (
                              <span className="w-4 h-4 rounded-full border border-muted-foreground/50 shrink-0 inline-block" />
                            )}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p
                              className={cn(
                                "text-sm leading-tight",
                                isCompleted && "line-through text-muted-foreground"
                              )}
                            >
                              {item.label}
                            </p>
                            {item.type === "slot" && hasSlotValue(slotValue) && (
                              <p
                                className={cn(
                                  "text-sm font-medium mt-1",
                                  isSuggested
                                    ? "text-amber-700 dark:text-amber-300"
                                    : "text-foreground"
                                )}
                              >
                                {String(slotValue)}
                              </p>
                            )}
                            {isSuggested && (
                              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1.5 py-0 text-amber-700 dark:text-amber-300 border-amber-500/60 bg-amber-500/10"
                                  title={
                                    status.is_correction
                                      ? tUi("Heard as a correction — confirm to replace the captured value")
                                      : undefined
                                  }
                                >
                                  {status.is_correction ? tUi("Correction") : tUi("Suggested")}
                                </Badge>
                                {confidencePercent !== null && (
                                  <span className="text-[10px] text-amber-600 dark:text-amber-400">
                                    {tUi("{value0}% confidence", { value0: confidencePercent })}
                                  </span>
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
  );
}

// Progress bar matching agent desktop format
function TestWorkflowProgressBar({
  stages,
  itemStatuses,
  completedItems,
  totalItems,
  currentStep,
}) {
  const tUi = useUiText();
  const displayPercentage =
    totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
  const isComplete = completedItems >= totalItems && totalItems > 0;
  const hasStages = stages?.length > 0;

  return (
    <div className="bg-card border-2 border-border rounded-lg p-3">
      <div className="flex items-center gap-4">
        {/* Stage indicators (left) */}
        <div className="flex items-center gap-1 shrink-0">
          {hasStages ? stages.map((stage, index) => {
            const completion = getStageCompletion(stage, itemStatuses);
            return (
              <div
                key={stage.id}
                className={cn(
                  "flex items-center",
                  index < (stages?.length || 1) - 1 && "gap-1"
                )}
                title={tUi("{value0}: {value1}/{value2}", { value0: stage.name, value1: completion.completed, value2: completion.total })}
              >
                <div
                  className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-all",
                    completion.isComplete && "bg-green-500 text-white",
                    completion.completed > 0 && "bg-purple-500/50 text-white",
                    completion.completed === 0 && "bg-muted text-muted-foreground"
                  )}
                >
                  {completion.isComplete ? (
                    <IconCircleCheck className="size-3.5" />
                  ) : (
                    index + 1
                  )}
                </div>
                {index < (stages?.length || 1) - 1 && (
                  <IconChevronRight className="size-3 text-muted-foreground" />
                )}
              </div>
            );
          }) : (
            <span className="text-sm text-muted-foreground">{tUi("No stages")}</span>
          )}
        </div>
        <div className="flex-1">
          <Progress
            value={displayPercentage}
            className="h-2"
            indicatorClassName="bg-green-500"
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm text-muted-foreground">
            {completedItems}/{totalItems}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "text-sm font-bold",
              isComplete
                ? "bg-green-500/10 text-green-500 border-green-500/50"
                : "bg-purple-500/10 text-purple-500 border-purple-500/50"
            )}
          >
            {displayPercentage}%
          </Badge>
          <span className="text-sm text-muted-foreground">{tUi("Turn ")}{currentStep}
          </span>
        </div>
      </div>
    </div>
  );
}

// Message bubble. Intent/sentiment badges were removed: the analyze-test
// route stopped returning them in #1365 (intent and sentiment run as their
// own request in the live path and never ride on slot extraction).
function Message({ message, isUser }) {
  const tUi = useUiText();
  const isManual = message.manual === true;

  return (
    <div className={cn("flex gap-3 mb-4", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "flex items-center justify-center w-8 h-8 rounded-full shrink-0",
          isUser
            ? "bg-blue-100 dark:bg-blue-900/50"
            : "bg-green-100 dark:bg-green-900/50"
        )}
      >
        {isUser ? (
          <IconUser className="size-4 text-blue-600 dark:text-blue-400" />
        ) : (
          <IconRobot className="size-4 text-green-600 dark:text-green-400" />
        )}
      </div>
      <div className={cn("flex flex-col max-w-[80%]", isUser && "items-end")}>
        <div
          className={cn(
            "rounded-lg px-4 py-2",
            isUser
              ? "bg-blue-500 text-white"
              : "bg-muted"
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className={cn("text-sm", message.streaming && "animate-pulse")}>{message.content}</p>
              {message.spoken && (
                <p className="mt-1 text-[11px] opacity-80" title={tUi("What the simulated caller said; the bubble shows what Telnyx heard")}>
                  {tUi("Spoken")}: {message.spoken}
                </p>
              )}
              {message.interrupted && (
                <p className="mt-1 text-[11px] text-amber-500">{tUi("Interrupted by the caller")}</p>
              )}
            </div>
            {isManual && isUser && (
              <IconPencil
                className="size-3.5 shrink-0 mt-0.5 opacity-80"
                title={tUi("Manually provided (auto flow stopped)")}
              />
            )}
          </div>
          <span className="text-xs opacity-70 mt-1 block">
            {new Date(message.timestamp).toLocaleTimeString(tUi.locale)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================
// TTS SERVICE FOR VOICE TESTS
// ============================================

// Synthesize the simulated caller's line. Returns the encoded audio so it can
// be decoded to PCM16 for the Telnyx conversation socket and, optionally,
// played locally for monitoring.
async function generateTTS(text, voice) {
  console.log(`[TTS] Generating for: "${text.substring(0, 50)}..." with voice: ${voice}`);

  const response = await fetch("/api/tts/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });

  if (!response.ok) {
    throw new Error(`TTS server error: ${response.status}`);
  }

  return {
    arrayBuffer: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") || "audio/mpeg",
  };
}

// Issue a workflow-scoped capability for the authenticated assistant call relay
// (the same relay the assistant configurator's Call button uses).
async function requestVoiceTestSession(workflowId) {
  const response = await fetch(`/api/admin/workflows/${workflowId}/voice-test-session`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      response.status === 401 ? "Your Contact Center session has ended. Sign in again."
        : response.status === 403 ? "You do not have permission to run voice tests."
        : data.error || "Could not prepare the voice test. Try again."
    );
  }
  return data;
}

const VOICE_INPUT_RATE = 16000;
// Select triggers in the configuration column fill the column and truncate long
// values (e.g. TTS voice names) instead of widening it.
const CONFIG_SELECT_TRIGGER = "w-full min-w-0 *:data-[slot=select-value]:block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate";
const VOICE_RESPONSE_WATCHDOG_MS = 12000;
// After a closing phrase the assistant usually hangs up itself; if it does not,
// the test is finished after this grace period.
const VOICE_ENDING_GRACE_MS = 5000;
// A typed MANUAL turn whose Telnyx echo has not arrived within this time is no
// longer expected.
const TEXT_ECHO_TTL_MS = 15000;
const normalizeEchoText = (text) => String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Model picker for one test run: the Admin → AI Copilot model list and the
// effective default with its source. Choosing another model applies to this
// test only; the workflow and AI Copilot settings are not changed.
function TestModelPicker({ id, label, hint, value, onChange, defaultModel, models, loading, disabled }) {
  const tUi = useUiText();
  const options = value && !models.some((m) => m.id === value) ? [{ id: value, name: value }, ...models] : models;
  const overridden = Boolean(value && defaultModel?.model && value !== defaultModel.model);
  const sourceText = overridden
    ? tUi("This test only. Default: {value0}", { value0: defaultModel.model })
    : defaultModel?.source === "workflow"
      ? tUi("Workflow setting (overrides AI Copilot)")
      : defaultModel?.source === "ai-copilot"
        ? tUi("From its Admin → AI Copilot card")
        : defaultModel?.source === "default"
          ? tUi("Platform default model (Admin → AI Copilot)")
          : defaultModel?.source === "env"
            ? tUi("Platform default from TELNYX_AI_DEFAULT_MODEL")
            : defaultModel && !defaultModel.model
              ? tUi("No model configured. Choose one here or in Admin → AI Copilot.")
              : "";
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
      {loading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <AIModels
          id={id}
          value={value}
          onValueChange={onChange}
          models={options}
          placeholder={tUi("Select model...")}
          triggerClassName="border bg-background"
          disabled={disabled}
        />
      )}
      <p className="text-xs text-muted-foreground">{hint}</p>
      {sourceText && (
        <div className="flex flex-wrap items-center gap-x-2 text-xs">
          <span className={overridden ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>{sourceText}</span>
          {overridden && !disabled && (
            <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => onChange(defaultModel.model)}>
              {tUi("Reset")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function TestAgentPage() {
  const tUi = useUiText();
  const router = useRouter();
  const params = useParams();
  const flowId = params.id;

  const [loading, setLoading] = useState(true);
  const [workflow, setWorkflow] = useState(null);
  const [channel, setChannel] = useState("chat"); // "chat" or "voice"

  // Dynamic response generation (on-the-fly customer simulation)
  // Persona vocabulary is shared with the Call Generator workflow tester
  // (neutral default + the full Ultra-emotion-aligned persona list).
  const [selectedPersona, setSelectedPersona] = useState("neutral");
  const [personas, setPersonas] = useState(WORKFLOW_TESTING_PERSONAS); // [{id,name/label,instruction}]
  const [expressive, setExpressive] = useState(false); // Expressive Mode: add Ultra/xAI TTS tags matching the persona
  const [customerData, setCustomerData] = useState(null); // Persisted fake data for this test session
  const [isGeneratingResponse, setIsGeneratingResponse] = useState(false); // Show "Customer is thinking..." indicator
  const [isMuted, setIsMuted] = useState(false); // Microphone mute state (MANUAL mode)

  // Models for this test. Defaults follow the platform precedence and come from
  // the server: analysis = workflow model > Admin → AI Copilot "Workflow
  // analysis" > built-in; caller = AI Copilot "Simulated customer" > built-in.
  // Picking another model applies to this test only; nothing is saved.
  const [modelCatalog, setModelCatalog] = useState([]);
  const [modelDefaults, setModelDefaults] = useState(null); // { analysis: {model, source}, caller: {model, source} }
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true);
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [analysisModel, setAnalysisModel] = useState("");
  const [callerModel, setCallerModel] = useState("");
  const [isTestRunning, setIsTestRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // Chat state
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [isAutoMode, setIsAutoMode] = useState(true);

  // Voice state
  const [voiceStatus, setVoiceStatus] = useState("idle"); // idle, connecting, active, error
  const [localAudioEnabled, setLocalAudioEnabled] = useState(true);
  const [agentState, setAgentState] = useState("idle");
  const [pendingAssistantText, setPendingAssistantText] = useState(null); // Assistant line being spoken (streamed transcript)
  const [userSpeaking, setUserSpeaking] = useState(false); // Telnyx VAD detected the caller's voice

  // TTS configuration
  const [ttsVoices, setTtsVoices] = useState({});
  const [ttsProvider, setTtsProvider] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoiceId, setTtsVoiceId] = useState(""); // Full voice ID like "Minimax.speech-2.8-turbo.English_male"

  // Agent state (from workflow config - no dropdown)
  const [agentId, setAgentId] = useState(null);
  const [assistantName, setAssistantName] = useState(null);

  // Chat conversation state
  const [conversationId, setConversationId] = useState(null);

  // Workflow analysis state (LLM-based, same as live agent desktop)
  const [workflowItemStatuses, setWorkflowItemStatuses] = useState({});
  const [workflowSlotsFilled, setWorkflowSlotsFilled] = useState({});
  const [isAnalyzingWorkflow, setIsAnalyzingWorkflow] = useState(false);

  // Refs
  const messagesEndRef = useRef(null);
  const voiceClientRef = useRef(null); // TelnyxAvatarClient for the active voice test
  const voiceEngineRef = useRef(null); // Turn engine fed with the client's raw Telnyx events
  const injectionRef = useRef(null); // Paced PCM sender for the caller line in flight
  const silenceStopRef = useRef(null); // Stops the silent-frame stream that keeps the caller's line alive (AUTO mode)
  const responseWatchdogRef = useRef(null); // Timer: assistant did not answer the caller
  const lastSpokenTextRef = useRef(null); // Text injected as the caller (compared with Telnyx STT)
  const pendingTextEchoesRef = useRef([]); // MANUAL text turns already shown locally; Telnyx echoes each as a transcription
  const callerUtteranceRef = useRef(0); // Token of the caller line in flight; hearing the caller or the assistant starting invalidates it
  const endingTimerRef = useRef(null); // Grace period after a closing phrase before the test is finished
  const voiceRetryRef = useRef(0); // Watchdog retries for the current caller line
  const autoModeRef = useRef(isAutoMode); // Track auto mode in ref for callbacks
  const isTestRunningRef = useRef(false); // Track test running for async stop checks
  const currentStepRef = useRef(0); // Track current step in ref for voice callbacks
  const respondingInProgressRef = useRef(false); // Prevent double responses
  const localAudioEnabledRef = useRef(true); // Track local audio playback
  const ttsVoiceRef = useRef("Minimax.speech-2.8-turbo.English_magnetic_voiced_man"); // Current TTS voice
  const expressiveRef = useRef(false); // Expressive Mode, read by voice callbacks without stale closures
  const selectedPersonaRef = useRef("neutral"); // Persona, read by voice callbacks / expression helper
  const analysisModelOverrideRef = useRef(""); // Per-test analysis model, read by the analysis queue
  const callerModelOverrideRef = useRef(""); // Per-test simulated caller model
  const isPausedRef = useRef(false); // Pause flag read inside the auto loop (the closure would be stale)
  const chatProcessingRef = useRef(false); // Prevent double processAIResponse in chat
  const customerDataRef = useRef(null); // Persist customer data across async calls
  customerDataRef.current = customerData;
  const messagesRef = useRef([]); // Track messages for async access without stale closures
  messagesRef.current = messages;

  // Slot analysis queue. One instance per page: every analysable line (chat
  // message or voice transcript item) is enqueued where it is appended to
  // `messages`, analysed one at a time in arrival order, and never cancelled
  // by a later line. The queue owns the item statuses / filled slots; React
  // state only mirrors them for rendering.
  const analysisEnabledRef = useRef(false);
  // `flowId` is a route param: a different workflow mounts a fresh page (and
  // a fresh queue), so capturing it here is exact.
  const [analysisQueue] = useState(() =>
    createTestAnalysisQueue({
      // The per-test model travels with each line (set when it is enqueued).
      analyze: (job) => analyzeWorkflowMessage(flowId, job, job.message?.analysisModel),
      onUpdate: ({ itemStatuses, slotsFilled }) => {
        setWorkflowItemStatuses(itemStatuses);
        setWorkflowSlotsFilled(slotsFilled);
      },
      onError: (err, job) => {
        if (err?.name === "AbortError") return;
        console.error("[Workflow Test] Analyze error:", err, job?.messageId);
      },
      onBusyChange: setIsAnalyzingWorkflow,
    })
  );

  useEffect(() => {
    analysisEnabledRef.current = Boolean(flowId && workflow?.stages?.length);
  }, [flowId, workflow?.stages?.length]);

  const enqueueForAnalysis = useCallback((message) => {
    if (!analysisEnabledRef.current || !isTestRunningRef.current) return;
    analysisQueue.enqueue(analysisModelOverrideRef.current ? { ...message, analysisModel: analysisModelOverrideRef.current } : message);
  }, [analysisQueue]);

  // Wait for the queue to finish every line enqueued so far (the caller's
  // answer and the assistant's reply), so the next simulated reply is
  // generated with the slots the analyzer has already filled.
  const waitForAnalysis = useCallback(async () => {
    await analysisQueue.idle();
  }, [analysisQueue]);

  // Generate dynamic customer response via LLM (on-the-fly, no pre-generated scenario)
  const generateDynamicResponse = useCallback(async (lastAiMessage, conversationHistory) => {
    console.log("[generateDynamicResponse] Called with:", {
      lastAiMessage: lastAiMessage?.substring(0, 50) + "...",
      historyLength: conversationHistory?.length,
      persona: selectedPersona,
      hasCustomerData: !!customerDataRef.current,
    });

    try {
      const res = await fetch(`/api/admin/workflows/${flowId}/generate-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          lastAiMessage,
          conversationHistory,
          persona: selectedPersona,
          customerData: customerDataRef.current,
          filledSlots: analysisQueue.getState().slotsFilled,
          // Voice + Expressive Mode let the simulated caller's reply carry the
          // matching TTS expression tags (Ultra <emotion>, xAI speech tags),
          // mirroring the Call Generator workflow tester.
          voice: ttsVoiceRef.current,
          expressive: expressiveRef.current,
          ...(callerModelOverrideRef.current ? { model: callerModelOverrideRef.current } : {}),
        }),
      });

      const data = await res.json();
      console.log("[generateDynamicResponse] API response:", { ok: res.ok, response: data.response?.substring(0, 50) });

      if (!res.ok) throw new Error(data.error || "Failed to generate response");

      // Store customer data for consistency across the test session
      if (data.customerData && !customerDataRef.current) {
        setCustomerData(data.customerData);
      }

      return data.response;
    } catch (err) {
      console.error("[generateDynamicResponse] Error:", err);
      notify({
        title: "Response Generation Failed",
        description: err.message,
        variant: "error",
      });
      return null;
    }
  }, [flowId, selectedPersona, analysisQueue]);

  // Keep refs in sync with state
  useEffect(() => {
    autoModeRef.current = isAutoMode;
  }, [isAutoMode]);

  useEffect(() => {
    currentStepRef.current = currentStep;
  }, [currentStep]);

  useEffect(() => {
    isTestRunningRef.current = isTestRunning;
  }, [isTestRunning]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    localAudioEnabledRef.current = localAudioEnabled;
    // Also (un)mute the assistant's voice on an active conversation.
    voiceClientRef.current?.setPlaybackHeld?.(!localAudioEnabled);
  }, [localAudioEnabled]);

  // Load TTS voices from API
  useEffect(() => {
    async function loadVoices() {
      try {
        const res = await fetch("/api/tts/voices");
        const data = await res.json();
        if (data.ok && data.providers) {
          // Transform providers array to nested object format: { provider: { model: [voices] } }
          const voicesMap = {};
          for (const provider of data.providers) {
            const providerId = provider.id || provider.name;
            voicesMap[providerId] = {};
            for (const model of provider.models || []) {
              const modelId = model.id || model.name || "default";
              // Deduplicate voices by ID
              const seenIds = new Set();
              const uniqueVoices = [];
              for (const v of model.voices || []) {
                if (v.id && !seenIds.has(v.id)) {
                  seenIds.add(v.id);
                  uniqueVoices.push({
                    id: v.id,
                    name: v.name || v.label || v.id,
                    gender: v.gender,
                    language: v.language,
                  });
                }
              }
              voicesMap[providerId][modelId] = uniqueVoices;
            }
          }
          setTtsVoices(voicesMap);

          // Set defaults - prefer Telnyx NaturalHD
          const providerKeys = Object.keys(voicesMap);
          if (providerKeys.length > 0) {
            const defaultProvider = providerKeys.includes("Telnyx") ? "Telnyx" : providerKeys[0];
            setTtsProvider(defaultProvider);
            const models = Object.keys(voicesMap[defaultProvider] || {});
            if (models.length > 0) {
              const defaultModel = models.includes("NaturalHD") ? "NaturalHD" : models[0];
              setTtsModel(defaultModel);
              const voices = voicesMap[defaultProvider][defaultModel] || [];
              if (voices.length > 0) {
                setTtsVoiceId(voices[0].id);
              }
            }
          }
        }
      } catch (err) {
        console.error("Failed to load TTS voices:", err);
      }
    }
    loadVoices();
  }, []);

  // Keep ttsVoiceRef in sync with selected voice ID
  useEffect(() => {
    ttsVoiceRef.current = ttsVoiceId;
  }, [ttsVoiceId]);

  // Keep expressive / persona refs in sync for voice callbacks (avoid stale closures)
  useEffect(() => {
    expressiveRef.current = expressive;
  }, [expressive]);
  useEffect(() => {
    selectedPersonaRef.current = selectedPersona;
  }, [selectedPersona]);

  // If the selected voice does not support expression (not Ultra / xAI),
  // Expressive Mode is meaningless — force it off so the toggle never silently
  // injects tags the TTS would speak literally.
  useEffect(() => {
    if (!voiceSupportsExpressive(ttsVoiceId) && expressive) {
      setExpressive(false);
    }
  }, [ttsVoiceId, expressive]);

  // Load the shared persona list (same vocabulary as the Call Generator workflow
  // tester). Falls back to the bundled WORKFLOW_TESTING_PERSONAS on failure.
  useEffect(() => {
    let cancelled = false;
    async function loadPersonas() {
      try {
        const res = await fetch(`/api/admin/workflows/${flowId}/generate-response`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data?.personas) && data.personas.length > 0) {
          setPersonas(data.personas);
        }
      } catch {
        // keep bundled fallback
      }
    }
    loadPersonas();
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  // Reset model and voice when provider changes
  useEffect(() => {
    if (!ttsProvider || !ttsVoices[ttsProvider]) return;
    const models = Object.keys(ttsVoices[ttsProvider] || {});
    if (models.length > 0) {
      setTtsModel(models[0]);
      const voices = ttsVoices[ttsProvider][models[0]] || [];
      if (voices.length > 0) {
        setTtsVoiceId(voices[0].id);
      }
    }
  }, [ttsProvider, ttsVoices]);

  // Reset voice when model changes
  useEffect(() => {
    if (!ttsProvider || !ttsModel || !ttsVoices[ttsProvider]) return;
    const voices = ttsVoices[ttsProvider]?.[ttsModel] || [];
    if (voices.length > 0) {
      // Voice ids are unique; names are not (Minimax lists several voices per name).
      const currentVoice = voices.find(v => v.id === ttsVoiceId);
      if (!currentVoice) {
        setTtsVoiceId(voices[0].id);
      }
    }
  }, [ttsModel, ttsProvider, ttsVoiceId, ttsVoices]);

  // Load the model catalogue (same list as Admin → AI Copilot) and the defaults.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/workflows/${flowId}/model-catalog`, { cache: "no-store", credentials: "include", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Model list unavailable");
        setModelCatalog(Array.isArray(data.models) ? data.models : []);
        setModelDefaults(data.defaults || null);
        setAnalysisModel(data.defaults?.analysis?.model || "");
        setCallerModel(data.defaults?.caller?.model || "");
        if (data.error) setModelCatalogError(data.error);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setModelCatalogError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setModelCatalogLoading(false);
      });
    return () => controller.abort();
  }, [flowId]);

  // A model equal to the default is not an override: the server resolves it.
  useEffect(() => {
    analysisModelOverrideRef.current =
      analysisModel && analysisModel !== modelDefaults?.analysis?.model ? analysisModel : "";
    callerModelOverrideRef.current =
      callerModel && callerModel !== modelDefaults?.caller?.model ? callerModel : "";
  }, [analysisModel, callerModel, modelDefaults]);

  // Load workflow data
  useEffect(() => {
    async function loadWorkflow() {
      try {
        const res = await fetch(`/api/admin/workflows/${flowId}`);
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Failed to load workflow");
        }
        const w = data.workflow;
        setWorkflow(w);
        if (w?.ai_assistant_id) {
          setAgentId(w.ai_assistant_id);
        } else {
          setAgentId(null);
        }
      } catch (err) {
        notify({
          title: "Error",
          description: err.message,
          variant: "error",
        });
        router.push(`/admin/workflows/${flowId}`);
      } finally {
        setLoading(false);
      }
    }
    loadWorkflow();
  }, [flowId, router]);

  // Resolve assistant name for display (workflow's assigned AI assistant)
  useEffect(() => {
    if (!workflow?.ai_assistant_id) {
      setAssistantName(null);
      return;
    }
    async function resolveAssistantName() {
      try {
        const res = await fetch("/api/ai/assistants?pageSize=100&onlyWorkflowAssistants=true");
        const data = await res.json();
        if (data.ok && data.items) {
          const assistant = data.items.find((a) => a.id === workflow.ai_assistant_id);
          setAssistantName(assistant?.name || workflow.ai_assistant_id);
        } else {
          setAssistantName(workflow.ai_assistant_id);
        }
      } catch (err) {
        setAssistantName(workflow.ai_assistant_id);
      }
    }
    resolveAssistantName();
  }, [workflow?.ai_assistant_id]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Persona option helpers (driven by the shared persona list). Each persona has
  // { id, name|label, instruction }; the description shown under the dropdown is
  // the persona's behavioural instruction (neutral has none).
  const personaLabel = (p) => p.name || p.label || p.id;
  const currentPersona = personas.find((p) => p.id === selectedPersona);
  const currentPersonaDescription =
    currentPersona?.instruction?.trim() ||
    (selectedPersona === "neutral" ? tUi("Cooperative caller, neutral tone — no extra behavioural pressure.") : "");

  const workflowStages = workflow?.stages ?? [];
  const totalWorkflowItems = workflowStages.reduce(
    (sum, s) => sum + (s.items?.length ?? 0),
    0
  );
  const completedWorkflowItems = Object.values(workflowItemStatuses).filter(
    (s) => s?.status === "completed"
  ).length;


  // Send chat message via REST API
  const sendChatMessage = useCallback(async (messageText, convId, stepIndex = null, options = {}) => {
    if (!agentId || !convId) return null;

    setSendingMessage(true);

    // Add user message to UI and queue it for slot analysis right away, so
    // the analyzer works while the assistant composes its reply.
    const userMessage = {
      id: uniqueMessageId("user"),
      role: "user",
      content: messageText,
      timestamp: new Date().toISOString(),
      manual: options.manual === true,
    };
    setMessages((prev) => [...prev, userMessage]);
    enqueueForAnalysis(userMessage);

    try {
      const res = await fetch(`/api/ai/assistants/${agentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: messageText,
          conversation_id: convId,
          name: "Test User",
        }),
      });

      const data = await res.json();
      setSendingMessage(false);

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Chat request failed");
      }

      const aiContent = data.content || data.response || "";

      // Add AI response to UI; it joins the queue behind the user's line.
      const aiMessage = {
        id: uniqueMessageId("ai"),
        role: "assistant",
        content: aiContent,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, aiMessage]);
      enqueueForAnalysis(aiMessage);

      return aiContent;
    } catch (err) {
      setSendingMessage(false);
      notify({
        title: "Chat Error",
        description: err.message,
        variant: "error",
      });
      return null;
    }
  }, [agentId, enqueueForAnalysis]);

  // Process AI response and send next customer response if in auto mode
  const processAIResponse = useCallback(async (aiContent, convId, currentStepIndex) => {
    if (!autoModeRef.current || !isTestRunningRef.current) return;

    try {
      // Dynamic response generation loop
      let currentAiMessage = aiContent;
      let stepNum = currentStepIndex;
      const MAX_TURNS = 50; // Safety limit to prevent infinite loops

      // Phrases that indicate conversation is ending
      // NOTE: Removed "thank you for calling" / "thanks for calling" - often used as greeting, not goodbye
      const ENDING_PHRASES = [
        "goodbye", "good bye", "have a great day", "have a nice day",
        "take care", "end the call", "ending the call", "disconnect", "hanging up",
      ];

      // Check if message indicates conversation ending
      const isConversationEnding = (message) => {
        if (!message) return false;
        const lower = message.toLowerCase();
        return ENDING_PHRASES.some(phrase => lower.includes(phrase));
      };

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (!isTestRunningRef.current) {
          console.log("[Dynamic] Test stopped");
          break;
        }
        // Pause holds the loop here until Resume or Stop. The flag is read
        // from a ref: the closure's `isPaused` is the value from when this
        // loop started, so it never saw the button.
        while (isPausedRef.current && isTestRunningRef.current) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!isTestRunningRef.current) break;
        if (!autoModeRef.current) {
          console.log("[Dynamic] Auto mode disabled");
          break;
        }

        // Check if AI is saying goodbye - if so, end the test
        if (isConversationEnding(currentAiMessage)) {
          console.log("[Dynamic] Detected conversation ending phrase, completing test");
          setMessages((prev) => [
            ...prev,
            {
              id: "system-complete",
              role: "system",
              content: "✅ Test completed - conversation ended naturally",
              timestamp: new Date().toISOString(),
            },
          ]);
          break;
        }

        // Build conversation history from messages ref (avoid stale closure)
        const conversationHistory = messagesRef.current
          .filter(m => m.role === "user" || m.role === "assistant")
          .map(m => ({ role: m.role, content: m.content }));

        console.log(`[Dynamic] Turn ${turn + 1}: Processing AI response:`, currentAiMessage?.substring(0, 50) + "...");

        await waitForAnalysis();
        if (!isTestRunningRef.current) break;

        // Generate dynamic response based on AI's message
        setIsGeneratingResponse(true);
        const dynamicResponse = await generateDynamicResponse(currentAiMessage, conversationHistory);
        setIsGeneratingResponse(false);

        if (!dynamicResponse) {
          console.error("[Dynamic] Failed to generate response, stopping");
          break;
        }
        if (!isTestRunningRef.current) break;

        console.log("[Dynamic] Generated response:", dynamicResponse?.substring(0, 50) + "...");
        setCurrentStep(++stepNum);

        // Send the generated response
        const nextAiResponse = await sendChatMessage(dynamicResponse, convId, stepNum);

        if (!isTestRunningRef.current) break;

        if (!nextAiResponse) {
          console.log("[Dynamic] No AI response received, stopping");
          break;
        }

        console.log("[Dynamic] AI responded:", nextAiResponse?.substring(0, 50) + "...");
        currentAiMessage = nextAiResponse;

        // Small delay before next iteration to prevent tight loops
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (err) {
      console.error("[Dynamic] Error in processAIResponse:", err);
    }
  }, [sendChatMessage, waitForAnalysis, generateDynamicResponse]);

  // Create a new conversation via Telnyx API
  const createConversation = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Workflow Test (${selectedPersona})`,
          metadata: {
            persona: selectedPersona,
            assistant_id: agentId,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to create conversation");
      }

      return data.id;
    } catch (err) {
      console.error("Failed to create conversation:", err);
      throw err;
    }
  }, [selectedPersona, agentId]);

  // Start chat test - uses REST API endpoint
  const startChatTest = useCallback(async () => {
    if (!agentId) {
      notify({
        title: "No Assistant Selected",
        description: "Please select or create an AI assistant first.",
        variant: "error",
      });
      return;
    }

    // Create new conversation via API
    let newConversationId;
    try {
      newConversationId = await createConversation();
      setConversationId(newConversationId);
    } catch (err) {
      notify({
        title: "Failed to create conversation",
        description: err.message,
        variant: "error",
      });
      return;
    }

    setIsTestRunning(true);
    isTestRunningRef.current = true; // the first lines are enqueued before React commits
    setIsPaused(false);
    isPausedRef.current = false;
    setMessages([]);
    setCurrentStep(0);
    currentStepRef.current = 0;
    analysisQueue.reset();
    setWorkflowItemStatuses({});
    setWorkflowSlotsFilled({});
    setCustomerData(null); // Reset customer data for new test session
    setAgentState("active");

    // Add system message
    setMessages([
      {
        id: "system-start",
        role: "system",
        content: `Starting chat test: ${selectedPersona} persona (REST API) · analysis model ${analysisModel || "default"} · caller model ${callerModel || "default"}`,
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      // Step 1: Send "Hello" to get welcome message from AI
      const welcomeResponse = await sendChatMessage("Hello", newConversationId);

      if (!welcomeResponse) {
        throw new Error("No welcome message from AI");
      }

      // Wait for workflow analysis of welcome exchange before sending first response
      await waitForAnalysis();

      // Generate first customer response based on AI's welcome
      setCurrentStep(1);
      const dynamicFirstResponse = await generateDynamicResponse(welcomeResponse, [
        { role: "user", content: "Hello" },
        { role: "assistant", content: welcomeResponse },
      ]);

      if (!dynamicFirstResponse) {
        throw new Error("Failed to generate customer response");
      }

      const firstAiResponse = await sendChatMessage(dynamicFirstResponse, newConversationId);

      if (isAutoMode && firstAiResponse) {
        await processAIResponse(firstAiResponse, newConversationId, 2);
      }

    } catch (err) {
      setAgentState("error");
      setIsTestRunning(false);
      notify({
        title: "Failed to start chat test",
        description: err.message,
        variant: "error",
      });
    }
  }, [agentId, isAutoMode, sendChatMessage, processAIResponse, createConversation, waitForAnalysis, selectedPersona, generateDynamicResponse, analysisQueue, analysisModel, callerModel]);

  // Speak text as the simulated caller: TTS → PCM16 16 kHz → paced
  // input_audio_buffer.append frames on the Telnyx conversation socket.
  // Resolves when the last frame (including trailing silence) has been sent.
  const speakTextViaAudio = useCallback(async (text) => {
    const client = voiceClientRef.current;
    if (!client?.active) {
      throw new Error("The voice conversation is not active");
    }

    // Expressive Mode: for Ultra voices prepend the persona's <emotion> tag,
    // for xAI voices prepend a fitting speech tag, so the simulated caller
    // sounds the part. Only when Expressive Mode is on and the voice family
    // supports it. The expressive text is only used for TTS — the chat bubble
    // and transcript keep the clean text.
    const spokenText = applyVoiceExpression(text, {
      voice: ttsVoiceRef.current,
      persona: selectedPersonaRef.current,
      expressive: expressiveRef.current,
    });

    const { arrayBuffer, contentType } = await generateTTS(spokenText, ttsVoiceRef.current);
    const pcm = await decodeToPcm16Mono(arrayBuffer, { rate: VOICE_INPUT_RATE });
    const { frames, speechMs } = buildInjection(pcm, { rate: VOICE_INPUT_RATE });
    if (!client.active || !isTestRunningRef.current) return { sent: 0, cancelled: true };

    lastSpokenTextRef.current = text;

    // Local monitoring of the caller's voice (optional).
    let monitorUrl = null;
    if (localAudioEnabledRef.current) {
      monitorUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: contentType }));
      const monitor = new Audio(monitorUrl);
      monitor.volume = 0.7;
      monitor.play().catch((e) => console.warn("[Voice] Local playback error:", e));
    }

    injectionRef.current?.cancel();
    // The token identifies this line. Telnyx may hear it (or start answering)
    // before the trailing silence is sent; that invalidates the token, so the
    // watchdog armed afterwards never fires for a line that was answered.
    const token = ++callerUtteranceRef.current;
    const sender = createPacedSender(frames, { send: (frame) => client.appendInputAudio(frame) });
    injectionRef.current = sender;
    console.log(`[Voice] Injecting ${(speechMs / 1000).toFixed(1)}s of caller speech (${frames.length} frames)`);
    try {
      return { ...(await sender.done), token };
    } finally {
      if (injectionRef.current === sender) injectionRef.current = null;
      if (monitorUrl) setTimeout(() => URL.revokeObjectURL(monitorUrl), 15000);
    }
  }, []);

  // Toggle mute (MANUAL mode) - mute/unmute the real microphone
  const toggleMute = useCallback(() => {
    const call = voiceClientRef.current?.call;
    if (!call) {
      console.warn("[Voice] No active call for mute toggle");
      return;
    }
    const newMutedState = !isMuted;
    setIsMuted(newMutedState);
    if (newMutedState) call.muteAudio?.(); else call.unmuteAudio?.();
    console.log(`[Voice] Microphone ${newMutedState ? "muted" : "unmuted"}`);
  }, [isMuted]);

  // Cancel in-flight caller audio and the response watchdog.
  const cancelVoiceActivity = useCallback(() => {
    silenceStopRef.current?.();
    silenceStopRef.current = null;
    injectionRef.current?.cancel();
    injectionRef.current = null;
    if (responseWatchdogRef.current) {
      clearTimeout(responseWatchdogRef.current);
      responseWatchdogRef.current = null;
    }
    if (endingTimerRef.current) {
      clearTimeout(endingTimerRef.current);
      endingTimerRef.current = null;
    }
    callerUtteranceRef.current += 1;
    pendingTextEchoesRef.current = [];
  }, []);

  // End the voice conversation (idempotent) and return the page to "Ready".
  const finishVoiceTest = useCallback((reason) => {
    cancelVoiceActivity();
    voiceEngineRef.current?.stop();
    const client = voiceClientRef.current;
    voiceClientRef.current = null;
    voiceEngineRef.current = null;
    if (client) {
      client.endConversation().catch(() => {});
      client.disconnect().catch(() => {});
    }
    const wasRunning = isTestRunningRef.current;
    isTestRunningRef.current = false;
    setIsTestRunning(false);
    setIsGeneratingResponse(false);
    setPendingAssistantText(null);
    setUserSpeaking(false);
    setIsMuted(false);
    setAgentState("idle");
    setVoiceStatus((status) => (status === "error" ? status : "idle"));
    if (reason && wasRunning) {
      setMessages((prev) => [
        ...prev,
        { id: uniqueMessageId("system"), role: "system", content: reason, timestamp: new Date().toISOString() },
      ]);
    }
  }, [cancelVoiceActivity]);

  // If the assistant does not start a response after the caller spoke, repeat
  // the line once (speech recognition may have missed it), then leave the turn
  // to the operator.
  const armResponseWatchdog = useCallback((text, token) => {
    const arm = (lineToken) => {
      // The line was already heard or answered while its audio was still being sent.
      if (lineToken !== callerUtteranceRef.current) return;
      if (responseWatchdogRef.current) clearTimeout(responseWatchdogRef.current);
      responseWatchdogRef.current = setTimeout(async () => {
        responseWatchdogRef.current = null;
        if (lineToken !== callerUtteranceRef.current) return;
        if (!isTestRunningRef.current || voiceEngineRef.current?.phase !== "caller") return;
        if (voiceRetryRef.current < 1) {
          voiceRetryRef.current += 1;
          setMessages((prev) => [
            ...prev,
            { id: uniqueMessageId("system"), role: "system", content: "The assistant did not respond within 12 s - repeating the caller's line once.", timestamp: new Date().toISOString() },
          ]);
          try {
            const result = await speakTextViaAudio(text);
            if (!result?.cancelled) arm(result.token);
          } catch (err) {
            console.error("[Voice] Retry failed:", err);
          }
          return;
        }
        setMessages((prev) => [
          ...prev,
          { id: uniqueMessageId("system"), role: "system", content: "No response from the assistant after two attempts. Type a message to continue or stop the test.", timestamp: new Date().toISOString() },
        ]);
      }, VOICE_RESPONSE_WATCHDOG_MS);
    };
    arm(token);
  }, [speakTextViaAudio]);

  // Send manual message - uses REST API for chat, TTS+inject for voice
  const sendMessage = useCallback(async () => {
    if (!inputMessage.trim() || sendingMessage) return;

    const messageText = inputMessage.trim();
    setInputMessage("");

    // A voice conversation id is never used for REST chat (the channel tabs are
    // also locked while a test runs).
    if (channel === "chat" && conversationId && !voiceClientRef.current) {
      // Chat mode - use REST API (mark as manual - user typed because auto flow stopped)
      const response = await sendChatMessage(messageText, conversationId, undefined, { manual: true });
      // In auto mode, process the response for next steps
      if (isAutoMode && response) {
        await processAIResponse(response, conversationId, currentStep);
      }
    } else if (channel === "voice" && voiceClientRef.current) {
      const client = voiceClientRef.current;
      setSendingMessage(true);
      try {
        if (isAutoMode) {
          // AUTO: speak the typed text through TTS as the simulated caller.
          const result = await speakTextViaAudio(messageText);
          if (!result?.cancelled) armResponseWatchdog(messageText, result.token);
        } else {
          // MANUAL: a text turn on the conversation socket (no TTS). The bubble
          // is added locally; Telnyx echoes text items as a completed
          // transcription (verified live). The user_final handler skips only an
          // echo that matches a pending typed text, so microphone speech that
          // arrives first is kept.
          pendingTextEchoesRef.current = [
            ...pendingTextEchoesRef.current.filter((echo) => Date.now() - echo.at < TEXT_ECHO_TTL_MS),
            { text: normalizeEchoText(messageText), at: Date.now() },
          ];
          client.sendConversationMessage(messageText);
          const typedMessage = { id: uniqueMessageId("user"), role: "user", content: messageText, manual: true, timestamp: new Date().toISOString() };
          setMessages((prev) => [...prev, typedMessage]);
          enqueueForAnalysis(typedMessage);
        }
      } catch (err) {
        notify({ title: "Voice Error", description: err.message, variant: "error" });
      } finally {
        setSendingMessage(false);
      }
    }
  }, [inputMessage, sendingMessage, channel, conversationId, sendChatMessage, isAutoMode, processAIResponse, currentStep, speakTextViaAudio, armResponseWatchdog, enqueueForAnalysis]);

  // Stop test - also clear conversation so no further messages can be sent
  const stopTest = useCallback(() => {
    chatProcessingRef.current = false;
    isTestRunningRef.current = false;
    setIsTestRunning(false);
    setIsPaused(false);
    setIsGeneratingResponse(false);
    setConversationId(null);
    setMessages((prev) => [
      ...prev,
      {
        id: "system-stopped",
        role: "system",
        content: "Test stopped by user",
        timestamp: new Date().toISOString(),
      },
    ]);

    // Clean up voice if active (ends the Telnyx conversation)
    finishVoiceTest();
    setVoiceStatus("idle");
  }, [finishVoiceTest]);

  // Reset test - regenerate scenario for current selection
  const resetTest = useCallback(() => {
    chatProcessingRef.current = false;
    isTestRunningRef.current = false;
    finishVoiceTest();
    setIsTestRunning(false);
    setIsPaused(false);
    setIsGeneratingResponse(false);
    setConversationId(null);
    setMessages([]);
    setCurrentStep(0);
    currentStepRef.current = 0;
    analysisQueue.reset();
    setWorkflowItemStatuses({});
    setWorkflowSlotsFilled({});
    setCustomerData(null); // Reset customer data for new test session
    setVoiceStatus("idle");
    setAgentState("idle");
    respondingInProgressRef.current = false;
  }, [finishVoiceTest, analysisQueue]);

  // Wait for the workflow analysis of the assistant's final line so the caller
  // LLM sees up-to-date filled slots. Bounded; never blocks the loop for long.
  const waitForVoiceAnalysis = useCallback(async () => {
    // Capped: in a voice conversation a long pause makes the assistant
    // re-prompt, so the caller replies after at most 2.5 s even if the queue
    // is still working (the queue itself keeps going and is never cancelled).
    let timer;
    await Promise.race([
      analysisQueue.idle(),
      new Promise((r) => { timer = setTimeout(r, 2500); }),
    ]);
    clearTimeout(timer);
  }, [analysisQueue]);

  // Simulated caller turn: opened by the turn engine after the assistant's
  // response completed (response.done). Generates the reply, speaks it, and
  // arms the watchdog. No settle timers - the next assistant turn is an event.
  const runCallerTurn = useCallback(async (lastAiMessage) => {
    if (!autoModeRef.current || respondingInProgressRef.current || !isTestRunningRef.current) return;
    if (!lastAiMessage) return;
    respondingInProgressRef.current = true;
    try {
      await waitForVoiceAnalysis();
      if (!isTestRunningRef.current || !autoModeRef.current) return;

      const conversationHistory = messagesRef.current
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      setIsGeneratingResponse(true);
      const responseText = await generateDynamicResponse(lastAiMessage, conversationHistory);
      setIsGeneratingResponse(false);
      if (!responseText || !isTestRunningRef.current) return;

      console.log(`[Voice] Responding: "${responseText.substring(0, 50)}..."`);
      setCurrentStep((prev) => prev + 1);
      currentStepRef.current += 1;
      voiceRetryRef.current = 0;

      const result = await speakTextViaAudio(responseText);
      if (!result?.cancelled && isTestRunningRef.current) armResponseWatchdog(responseText, result.token);
    } catch (err) {
      console.error("[Voice] Caller turn failed:", err);
      if (isTestRunningRef.current) {
        notify({ title: "Voice Error", description: err.message, variant: "error" });
      }
    } finally {
      respondingInProgressRef.current = false;
      setIsGeneratingResponse(false);
    }
  }, [waitForVoiceAnalysis, generateDynamicResponse, speakTextViaAudio, armResponseWatchdog]);

  // Start voice test over the authenticated Telnyx conversation WebSocket.
  // AUTO mode injects TTS audio as the caller; MANUAL mode streams the real
  // microphone. Both use the same relay as the assistant configurator's Call
  // button, so anonymous web calling on the assistant is not required.
  const startVoiceTest = useCallback(async () => {
    if (!agentId) {
      notify({
        title: "No Assistant Selected",
        description: "Please select or create an AI assistant first.",
        variant: "error",
      });
      return;
    }

    cancelVoiceActivity();
    isTestRunningRef.current = true;
    setIsTestRunning(true);
    setVoiceStatus("connecting");
    setAgentState("idle");
    respondingInProgressRef.current = false;
    voiceRetryRef.current = 0;
    lastSpokenTextRef.current = null;
    setCurrentStep(0);
    currentStepRef.current = 0;
    analysisQueue.reset();
    setWorkflowItemStatuses({});
    setWorkflowSlotsFilled({});
    setCustomerData(null); // Reset customer data for new voice test session
    setIsGeneratingResponse(false);
    setIsMuted(false);
    setConversationId(null);
    setPendingAssistantText(null);
    setUserSpeaking(false);

    const currentAutoMode = isAutoMode; // Capture for closure
    setMessages([
      {
        id: "system-voice-start",
        role: "system",
        content: `Starting voice test: ${selectedPersona} persona (${currentAutoMode ? "AUTO - TTS injection" : "MANUAL - real microphone"}) over the Telnyx conversation WebSocket · analysis model ${analysisModel || "default"} · caller model ${callerModel || "default"}`,
        timestamp: new Date().toISOString(),
      },
    ]);

    const client = new TelnyxAvatarClient();
    const engine = createVoiceTestEngine();
    voiceClientRef.current = client;
    voiceEngineRef.current = engine;
    client.setPlaybackHeld(!localAudioEnabledRef.current);

    const pushSystem = (content) =>
      setMessages((prev) => [...prev, { id: uniqueMessageId("system"), role: "system", content, timestamp: new Date().toISOString() }]);

    const handleAction = (action) => {
      if (voiceClientRef.current !== client) return; // stale client after stop/reset
      switch (action.type) {
        case "session":
          setVoiceStatus("active");
          setConversationId(action.conversationId);
          if (currentAutoMode) {
            // Keep the caller's line carrying silence between utterances so the
            // server-side VAD can close each turn (a microphone never stops).
            silenceStopRef.current?.();
            silenceStopRef.current = createSilenceStreamer({
              send: (frame) => client.appendInputAudio(frame),
              isPaused: () => Boolean(injectionRef.current) || !client.active,
            });
          }
          pushSystem(`✅ Connected to the assistant (${currentAutoMode ? "AUTO mode - TTS injection" : "MANUAL mode - real microphone"})${action.conversationId ? ` · conversation ${action.conversationId}` : ""}`);
          break;
        case "assistant_started":
          callerUtteranceRef.current += 1; // the caller's line was answered
          if (responseWatchdogRef.current) {
            clearTimeout(responseWatchdogRef.current);
            responseWatchdogRef.current = null;
          }
          setPendingAssistantText("");
          break;
        case "assistant_delta":
          setPendingAssistantText(action.text);
          break;
        case "assistant_final": {
          setPendingAssistantText(null);
          const assistantMessage = {
            id: action.responseId || uniqueMessageId("assistant"),
            role: "assistant",
            content: action.text,
            interrupted: action.interrupted === true,
            timestamp: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, assistantMessage]);
          enqueueForAnalysis(assistantMessage);
          break;
        }
        case "user_final": {
          // The caller was heard: the assistant is now thinking, however long
          // that takes. Only an unheard line is ever repeated.
          callerUtteranceRef.current += 1;
          if (responseWatchdogRef.current) {
            clearTimeout(responseWatchdogRef.current);
            responseWatchdogRef.current = null;
          }
          // The echo of a typed MANUAL turn is already shown; match it by text so
          // microphone speech arriving first is not dropped.
          const pendingEchoes = pendingTextEchoesRef.current.filter((echo) => Date.now() - echo.at < TEXT_ECHO_TTL_MS);
          const echoIndex = pendingEchoes.findIndex((echo) => echo.text === normalizeEchoText(action.text));
          if (echoIndex >= 0) {
            pendingTextEchoesRef.current = pendingEchoes.filter((_, index) => index !== echoIndex);
            break;
          }
          pendingTextEchoesRef.current = pendingEchoes;
          const spoken = lastSpokenTextRef.current;
          lastSpokenTextRef.current = null;
          if (!action.text) break;
          // Analysed as Telnyx heard it: that is what the assistant acted on.
          const callerMessage = {
            id: action.itemId || uniqueMessageId("user"),
            role: "user",
            content: action.text,
            spoken: spoken && spoken.trim() !== action.text.trim() ? spoken : undefined,
            timestamp: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, callerMessage]);
          enqueueForAnalysis(callerMessage);
          break;
        }
        case "caller_turn":
          void runCallerTurn(action.text);
          break;
        case "silent_response":
          pushSystem("The assistant completed a turn without speaking.");
          break;
        case "ending":
          pushSystem("✅ Test completed - conversation ended naturally");
          // No more caller turns. Give the assistant a moment to hang up itself,
          // then finish the test (WebSocket, silence stream and microphone).
          if (endingTimerRef.current) clearTimeout(endingTimerRef.current);
          endingTimerRef.current = setTimeout(() => {
            endingTimerRef.current = null;
            if (voiceClientRef.current === client && isTestRunningRef.current) finishVoiceTest();
          }, VOICE_ENDING_GRACE_MS);
          break;
        case "response_failed":
          finishVoiceTest(`The assistant could not finish its response (Telnyx status: ${action.status}). The test was stopped so the simulated caller does not answer a cut-off line.`);
          break;
        case "user_speaking":
          setUserSpeaking(true);
          break;
        case "user_stopped":
          setUserSpeaking(false);
          break;
        case "tool":
          pushSystem(`🔧 Tool ${action.name || ""} ${action.status}`.replace(/\s+/g, " "));
          break;
        case "error":
          console.error("[Voice] Telnyx error:", action);
          notify({ title: "Voice Error", description: action.message, variant: "error" });
          if (["session_idle_timeout", "session_max_duration_exceeded", "conversation_ended"].includes(action.code)) {
            finishVoiceTest("The Telnyx session ended.");
          }
          break;
        case "ended":
          finishVoiceTest("The assistant ended the conversation.");
          break;
        default:
          break;
      }
    };

    client.on("assistant.event", (frame) => {
      for (const action of engine.handle(frame)) handleAction(action);
    });
    client.on("conversation.agent.state", ({ state }) => {
      if (voiceClientRef.current === client) setAgentState(state);
    });
    client.on("conversation.update", ({ call }) => {
      if (voiceClientRef.current !== client) return;
      if (call?.state === "hangup" && isTestRunningRef.current) finishVoiceTest("The call ended.");
    });
    client.on("agent.error", (err) => {
      if (voiceClientRef.current !== client) return;
      const errorMessage = err?.message || (typeof err === "string" ? err : "An unknown error occurred");
      console.error("[Voice Test] Agent error:", err);
      notify({ title: "Voice Error", description: errorMessage, variant: "error" });
      setVoiceStatus("error");
      finishVoiceTest();
    });

    try {
      await client.startConversation({
        capture: currentAutoMode ? "none" : "microphone",
        avatarSession: () => requestVoiceTestSession(flowId),
      });
      console.log(`[Voice] Conversation started (${currentAutoMode ? "AUTO" : "MANUAL"} mode) - waiting for AI greeting...`);
    } catch (err) {
      if (voiceClientRef.current !== client) return; // stopped while connecting
      let errorMessage = err?.message || "An unknown error occurred";
      if (err?.name === "NotAllowedError") errorMessage = "Allow microphone access in your browser, then try again.";
      if (err?.name === "NotFoundError") errorMessage = "No microphone was found. Connect a microphone, then try again.";
      setVoiceStatus("error");
      finishVoiceTest();
      notify({ title: "Failed to start voice test", description: errorMessage, variant: "error" });
      console.error("[Voice Test] Failed to start:", err);
    }
  }, [agentId, flowId, selectedPersona, isAutoMode, cancelVoiceActivity, finishVoiceTest, runCallerTurn, enqueueForAnalysis, analysisQueue, analysisModel, callerModel]);

  if (loading) {
    return (
      <AdminPageShell>
        <AdminPageHeader title={tUi("Test AI Agent")} badges={<Badge variant="secondary">{tUi("Loading")}</Badge>} />
        <AdminPageContent>
          <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <IconRobot className="h-5 w-5 text-telnyx-green" />{tUi("Test AI Agent")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-[600px] w-full" />
          </CardContent>
        </Card>
        </AdminPageContent>
      </AdminPageShell>
    );
  }

  return (
    <AdminPageShell>
      <AdminPageHeader title={tUi("Test AI Agent")} badges={<Badge variant="secondary">{workflow?.name || tUi("Workflow")}</Badge>} />
      <AdminPageContent>
        <div className="space-y-4">
      <Card className="w-full shadow-sm flex flex-col overflow-hidden" style={{ height: "90vh" }}>
        <CardHeader className="flex flex-row items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/admin/workflows/${flowId}`)}
            >
              <IconArrowLeft className="size-4 mr-2" />{tUi("Back to Workflow")}</Button>
            <Separator orientation="vertical" className="h-6" />
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <IconRobot className="h-5 w-5 text-telnyx-green" />{tUi("Test AI Agent")}</CardTitle>
            <div className="text-sm text-muted-foreground">
              {workflow?.name || tUi("Workflow")}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 md:p-6 h-full flex flex-col overflow-hidden">
          <div className="flex h-full min-h-0 gap-6">
          {/* Left: config panel as Card. Its content never scrolls sideways:
              long values (voices, personas) are truncated to the column. */}
          <Card className="w-96 shrink-0 flex flex-col overflow-hidden">
            <div className="shrink-0 border-b px-4 py-3 mb-4">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <IconSettings className="size-4 text-blue-500" />{tUi("Configuration")}</h3>
              <p className="text-xs text-muted-foreground mt-1">{tUi("Test setup and controls")}</p>
            </div>
            <CardContent className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 pb-4 space-y-4">
              <TestModelPicker
                id="test-analysis-model"
                label={tUi("Workflow analysis model")}
                hint={tUi("Slot filling and corrections in this test.")}
                value={analysisModel}
                onChange={setAnalysisModel}
                defaultModel={modelDefaults?.analysis}
                models={modelCatalog}
                loading={modelCatalogLoading}
                disabled={isTestRunning}
              />
              <TestModelPicker
                id="test-caller-model"
                label={tUi("Simulated caller model")}
                hint={tUi("Generates the simulated customer's replies.")}
                value={callerModel}
                onChange={setCallerModel}
                defaultModel={modelDefaults?.caller}
                models={modelCatalog}
                loading={modelCatalogLoading}
                disabled={isTestRunning}
              />
              {modelCatalogError && (
                <p role="alert" className="text-xs text-destructive">{modelCatalogError}</p>
              )}
              <div className="space-y-4">
                {/* AI Assistant (from workflow config) */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">{tUi("AI Assistant")}</label>
                  <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
                    {agentId ? (
                      assistantName ? (
                        assistantName
                      ) : (
                        <span className="text-muted-foreground">{tUi("Loading…")}</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">{tUi("Not assigned")}</span>
                    )}
                  </div>
                  {!agentId && (
                    <p className="text-xs text-muted-foreground">{tUi("Create an AI Agent from the workflow page and assign it to this workflow.")}</p>
                  )}
                </div>

                {/* Customer Persona */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">{tUi("Customer Persona")}</label>
                  <Select
                    value={selectedPersona}
                    onValueChange={setSelectedPersona}
                    disabled={isTestRunning}
                  >
                    <SelectTrigger className={CONFIG_SELECT_TRIGGER}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {personas.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {personaLabel(p)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {currentPersonaDescription}
                  </p>
                </div>

                {/* Channel Selection */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">{tUi("Channel")}</label>
                  {/* Locked while a test runs: a chat and a voice run must never
                      share one conversation or run two loops at once. */}
                  <Tabs value={channel} onValueChange={(value) => { if (!isTestRunningRef.current) setChannel(value); }}>
                    <TabsList aria-label={tUi("Channel")}>
                      <TabsTrigger value="chat" disabled={isTestRunning}>
                        <IconMessageCircle className="size-4" />{tUi("Chat")}</TabsTrigger>
                      <TabsTrigger value="voice" disabled={isTestRunning}>
                        <IconPhone className="size-4" />{tUi("Voice")}</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>

                {/* Auto Mode Toggle */}
                <div className="flex items-center justify-between">
                  <Label htmlFor="auto-mode" className="text-sm font-medium cursor-pointer">{tUi("Auto Mode")}</Label>
                  <Switch
                    id="auto-mode"
                    checked={isAutoMode}
                    onCheckedChange={setIsAutoMode}
                    disabled={isTestRunning}
                  />
                </div>

                {/* Audio monitoring: hear the assistant and the simulated caller locally */}
                {channel === "voice" && (
                  <div className="flex items-center justify-between">
                    <Label htmlFor="audio-monitoring" className="text-sm font-medium cursor-pointer flex items-center gap-1.5">
                      {localAudioEnabled ? <IconVolume className="size-4" /> : <IconVolumeOff className="size-4" />}{tUi("Audio monitoring")}</Label>
                    <Switch
                      id="audio-monitoring"
                      checked={localAudioEnabled}
                      onCheckedChange={setLocalAudioEnabled}
                    />
                  </div>
                )}

                {/* TTS Configuration (Voice channel + AUTO mode only) */}
                {channel === "voice" && isAutoMode && (
                  <div className="space-y-3 pt-3 border-t">
                    <label className="text-sm font-medium">{tUi("TTS Voice")}</label>

                    {/* Provider */}
                    <Select
                      value={ttsProvider}
                      onValueChange={setTtsProvider}
                      disabled={isTestRunning}
                    >
                      <SelectTrigger size="sm" className={CONFIG_SELECT_TRIGGER}>
                        <SelectValue placeholder={tUi("Provider")} />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.keys(ttsVoices).map((provider) => (
                          <SelectItem key={provider} value={provider}>
                            {provider.charAt(0).toUpperCase() + provider.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* Model */}
                    <Select
                      value={ttsModel}
                      onValueChange={setTtsModel}
                      disabled={isTestRunning}
                    >
                      <SelectTrigger size="sm" className={CONFIG_SELECT_TRIGGER}>
                        <SelectValue placeholder={tUi("Model")} />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.keys(ttsVoices[ttsProvider] || {}).map((model) => (
                          <SelectItem key={model} value={model}>
                            {model}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* Voice */}
                    {/* Keyed by voice id: several voices can share a name, and a
                        name used as the value showed every match in the trigger. */}
                    <Select
                      value={ttsVoiceId}
                      onValueChange={setTtsVoiceId}
                      disabled={isTestRunning}
                    >
                      <SelectTrigger size="sm" className={CONFIG_SELECT_TRIGGER}>
                        <SelectValue placeholder={tUi("Voice")} />
                      </SelectTrigger>
                      <SelectContent>
                        {(ttsVoices[ttsProvider]?.[ttsModel] || []).map((voice) => (
                          <SelectItem key={voice.id} value={voice.id}>
                            {voice.name} {voice.gender ? tUi("({value0})", { value0: voice.gender }) : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* Expressive Mode — only meaningful for Telnyx Ultra and
                        xAI voices, which support inline expression tags. The
                        simulated caller's reply gets persona-matching <emotion>
                        (Ultra) or speech tags (xAI), just like the Call Generator. */}
                    {voiceSupportsExpressive(ttsVoiceId) && (
                      <div className="flex items-center justify-between pt-1">
                        <div className="pr-2">
                          <Label htmlFor="expressive-mode" className="text-sm font-medium cursor-pointer">{tUi("Expressive Mode")}</Label>
                          <p className="text-xs text-muted-foreground">{tUi("Add ")}{ttsVoiceId.startsWith("xAI.") ? tUi("xAI speech") : tUi("Ultra emotion")}{tUi(" tags matching the persona")}</p>
                        </div>
                        <Switch
                          id="expressive-mode"
                          checked={expressive}
                          onCheckedChange={setExpressive}
                          disabled={isTestRunning}
                        />
                      </div>
                    )}

                    <p className="text-xs text-muted-foreground pt-1">{tUi("The simulated caller replies as soon as the assistant finishes a response (Telnyx response.done); turn-taking is event-driven.")}</p>
                  </div>
                )}
              </div>

            <div className="pt-2 border-t">
              <h3 className="text-sm font-semibold mb-2">{tUi("Controls")}</h3>
              {/* Status Badge - shows Voice Status when voice test active, otherwise Ready/Test Running */}
              {isTestRunning && channel === "voice" ? (
                <Badge
                  variant="outline"
                  className={cn(
                    "mb-3 w-full justify-center gap-1.5",
                    agentState === "listening" && "text-blue-500 border-blue-500",
                    agentState === "speaking" && "text-green-500 border-green-500",
                    agentState === "thinking" && "text-yellow-500 border-yellow-500",
                    agentState === "idle" && "text-muted-foreground",
                    voiceStatus === "connecting" && "text-yellow-500 border-yellow-500",
                    voiceStatus === "error" && "text-red-500 border-red-500"
                  )}
                >
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    agentState === "listening" && "bg-blue-500",
                    agentState === "speaking" && "bg-green-500 animate-pulse",
                    agentState === "thinking" && "bg-yellow-500 animate-pulse",
                    agentState === "idle" && "bg-muted-foreground",
                    voiceStatus === "connecting" && "bg-yellow-500 animate-pulse",
                    voiceStatus === "error" && "bg-red-500"
                  )} />
                  {voiceStatus === "connecting" ? tUi("Connecting...") :
                   voiceStatus === "error" ? tUi("Error") :
                   userSpeaking ? tUi("Caller speaking") :
                   agentState.charAt(0).toUpperCase() + agentState.slice(1)}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className={cn(
                    "mb-3 w-full justify-center gap-1.5",
                    isTestRunning
                      ? "text-green-500 border-green-500"
                      : "text-emerald-500 border-emerald-500"
                  )}
                >
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    isTestRunning ? "bg-green-500 animate-pulse" : "bg-emerald-500"
                  )} />
                  {isTestRunning ? tUi("Test Running") : tUi("Ready")}
                </Badge>
              )}
              {channel === "voice" && conversationId && (
                <p className="mb-3 break-all text-[11px] text-muted-foreground" title={tUi("Telnyx conversation ID")}>
                  {tUi("Conversation")}: <span className="font-mono">{conversationId}</span>
                </p>
              )}
              <div className="space-y-3">
                {!isTestRunning ? (
                  <Button
                    className="w-full"
                    onClick={channel === "chat" ? startChatTest : startVoiceTest}
                    disabled={!agentId}
                  >
                    <IconPlayerPlay className="size-4 mr-2" />{tUi("Start Test")}</Button>
                ) : (
                  <>
                    {channel === "chat" && (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => setIsPaused(!isPaused)}
                      >
                        {isPaused ? (
                          <>
                            <IconPlayerPlay className="size-4 mr-2" />{tUi("Resume")}</>
                        ) : (
                          <>
                            <IconPlayerStop className="size-4 mr-2" />{tUi("Pause")}</>
                        )}
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      className="w-full"
                      onClick={stopTest}
                    >
                      <IconX className="size-4 mr-2" />{tUi("Stop Test")}</Button>
                  </>
                )}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={resetTest}
                >
                  <IconRefresh className="size-4 mr-2" />{tUi("Reset")}</Button>
              </div>
            </div>

            </CardContent>
          </Card>

          {/* Middle: Agent View (50%) + Conversation (50%) as separate Cards */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0 gap-6">
            <div className="flex-1 grid grid-cols-2 gap-6 min-h-0">
              {/* Workflow Card */}
              <Card className="flex flex-col min-h-0 overflow-hidden">
                <div className="shrink-0 border-b px-4 py-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <IconClipboardList className="size-4 text-purple-500" />{tUi("Workflow")}{isAnalyzingWorkflow && (
                      <Badge variant="outline" className="ml-auto text-xs animate-pulse bg-purple-500/10 text-purple-500 border-purple-500/50">
                        <IconLoader2 className="size-3 mr-1 animate-spin" />{tUi("Analyzing")}</Badge>
                    )}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">{tUi("LLM analyzes the conversation for slot extraction")}</p>
                </div>
                <CardContent className="flex-1 min-h-0 overflow-hidden p-0">
                  <WorkflowAgentView
                    stages={workflowStages}
                    itemStatuses={workflowItemStatuses}
                  />
                </CardContent>
              </Card>

              {/* Simulated Conversation Card */}
              <Card className="flex flex-col min-h-0 overflow-hidden">
                <div className="shrink-0 border-b px-4 py-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    {channel === "chat" ? (
                      <>
                        <IconMessageCircle className="size-4 text-green-500" />{tUi("Simulated Conversation")}</>
                    ) : (
                      <>
                        <IconPhone className="size-4 text-green-500" />{tUi("Simulated Conversation")}</>
                    )}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">{tUi("Chat or voice messages from the test run")}</p>
                </div>
                <CardContent className="flex-1 flex flex-col overflow-hidden p-0 min-h-0">
                {/* Messages Area */}
                <div className="flex-1 min-h-0 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="space-y-1 py-4 px-4">
                    {messages.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full text-center py-12">
                        <IconRobot className="size-12 text-muted-foreground/50 mb-4" />
                        <p className="text-sm text-muted-foreground">{tUi("No messages yet")}</p>
                        <p className="text-xs text-muted-foreground mt-1">{tUi("Click \"Start Test\" to begin")}</p>
                      </div>
                    ) : (
                      messages.map((message, idx) => {
                        const key = `${message.id}-${idx}`;
                        if (message.role === "system") {
                          return (
                            <div
                              key={key}
                              className="text-center text-xs text-muted-foreground py-2"
                            >
                              {message.content}
                            </div>
                          );
                        }
                        return (
                          <Message
                            key={key}
                            message={message}
                            isUser={message.role === "user"}
                          />
                        );
                      })
                    )}
                    {pendingAssistantText !== null && (
                      <Message
                        message={{ id: "assistant-pending", role: "assistant", content: pendingAssistantText || "…", timestamp: new Date().toISOString(), streaming: true }}
                        isUser={false}
                      />
                    )}
                    {isGeneratingResponse && (
                      <div className="flex items-center gap-2 text-purple-400 justify-end">
                        <span className="text-sm">{tUi("Customer is thinking...")}</span>
                        <IconLoader2 className="size-4 animate-spin" />
                      </div>
                    )}
                    {sendingMessage && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <IconLoader2 className="size-4 animate-spin" />
                        <span className="text-sm">{tUi("AI is typing...")}</span>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                    </div>
                  </ScrollArea>
                </div>

                {/* Input Area (Chat and Voice) */}
                {isTestRunning && (
                  <div className="shrink-0 border-t p-4">
                    <div className="flex gap-2">
                      <Input
                        value={inputMessage}
                        onChange={(e) => setInputMessage(e.target.value)}
                        placeholder={channel === "voice" ? (isAutoMode ? tUi("Type to speak via TTS...") : tUi("Type a text turn...")) : tUi("Type a message...")}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                          }
                        }}
                        disabled={sendingMessage}
                      />
                      {/* Voice mode: Mute/Unmute button (MANUAL mode only) */}
                      {channel === "voice" && !isAutoMode && (
                        <Button
                          variant={isMuted ? "destructive" : "outline"}
                          onClick={toggleMute}
                          disabled={!isTestRunning}
                          title={isMuted ? tUi("Unmute microphone") : tUi("Mute microphone")}
                        >
                          {isMuted ? (
                            <IconMicrophoneOff className="size-4" />
                          ) : (
                            <IconMicrophone className="size-4" />
                          )}
                        </Button>
                      )}
                      {/* Send button */}
                      <Button
                        onClick={sendMessage}
                        disabled={sendingMessage || !inputMessage.trim()}
                      >
                        <IconSend className="size-4" />
                      </Button>
                    </div>
                    {channel === "voice" && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {isAutoMode
                          ? tUi("Type text → converted to speech via TTS → sent to AI")
                          : (isMuted
                              ? tUi("🔇 Microphone muted - click to unmute. Typed text is sent as a text turn.")
                              : tUi("🎤 Microphone active - speak naturally or click to mute. Typed text is sent as a text turn."))
                        }
                      </p>
                    )}
                  </div>
                )}
                </CardContent>
              </Card>
            </div>

            {/* Progress panel at bottom */}
            <div className="shrink-0">
              <TestWorkflowProgressBar
                stages={workflowStages}
                itemStatuses={workflowItemStatuses}
                completedItems={completedWorkflowItems}
                totalItems={totalWorkflowItems}
                currentStep={currentStep}
              />
            </div>
          </div>
          </div>
        </CardContent>
      </Card>
        </div>
      </AdminPageContent>
    </AdminPageShell>
  );
}
