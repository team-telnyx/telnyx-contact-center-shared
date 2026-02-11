"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
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
  IconMoodSmile,
  IconMoodSad,
  IconMoodNeutral,
  IconTarget,
  IconPencil,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { cn } from "@/lib/utils";
import { getIntentLabel } from "@/lib/agent-assist/sentiment-analysis";

// TTS options will be loaded dynamically from API

/** Generate unique message ID to avoid React key collisions and doubled rendering */
function uniqueMessageId(prefix = "msg") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Test scenarios - all LLM-generated via /api/admin/workflows/[id]/generate-test-scenario
 * Each scenario has predefined instructions; data is regenerated on selection change and Reset.
 */
import { SCENARIO_TYPES } from "@/lib/agent-assist/generate-test-scenario";

const SCENARIO_LIST = Object.values(SCENARIO_TYPES);

/**
 * Find the scenario step that best matches the last AI message.
 * Uses keyword matching (same as processAIResponse) - finds the first step whose
 * keywords appear in the AI's message, so the response is relevant to what the AI asked.
 * Also considers workflow state: prefers steps that correspond to pending workflow items.
 */
function findScenarioStepForLastAiMessage(messages, scenario, workflowStages, itemStatuses = {}) {
  if (!scenario?.responses?.length) return 0;

  const lastAiMessage = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content?.trim());
  const lastAiText = (lastAiMessage?.content || "").toLowerCase();

  if (!lastAiText) return 0;

  let bestMatch = { index: -1, score: 0 };
  for (let i = 0; i < scenario.responses.length; i++) {
    const step = scenario.responses[i];
    if (!step.keywords) continue;

    const matchCount = step.keywords.filter((kw) =>
      lastAiText.includes(String(kw).toLowerCase())
    ).length;
    if (matchCount === 0) continue;

    const score = matchCount;
    if (score > bestMatch.score) {
      bestMatch = { index: i, score };
    }
  }

  return bestMatch.score > 0 ? bestMatch.index : 0;
}

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

// Analyze a single message for workflow item completion (same LLM as live agent desktop)
async function analyzeWorkflowMessage(workflowId, transcript, speaker, itemStatuses, slotsFilled) {
  const res = await fetch(`/api/admin/workflows/${workflowId}/analyze-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      transcript,
      speaker,
      itemStatuses,
      slotsFilled,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Analysis failed");
  return data;
}

// Workflow agent view - stages in accordions, crossed out when complete
function WorkflowAgentView({ stages, itemStatuses }) {
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
        <p className="text-sm">No workflow stages</p>
        <p className="text-xs mt-1">Configure stages in the workflow editor</p>
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
                      const slotValue =
                        status.value || status.extracted_value;
                      return (
                        <div
                          key={item.id}
                          className={cn(
                            "flex items-start gap-2 p-2 rounded-md",
                            isCompleted && "bg-green-500/10",
                            !isCompleted && "hover:bg-muted/50"
                          )}
                        >
                          <span className="mt-0.5">
                            {isCompleted ? (
                              <IconCircleCheck className="size-4 text-green-500 shrink-0" />
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
                            {item.type === "slot" && slotValue && (
                              <p className="text-sm font-medium text-foreground mt-1">
                                {slotValue}
                              </p>
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
  totalScenarioSteps,
}) {
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
                title={`${stage.name}: ${completion.completed}/${completion.total}`}
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
            <span className="text-sm text-muted-foreground">No stages</span>
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
          <span className="text-sm text-muted-foreground">
            Step {currentStep}/{totalScenarioSteps}
          </span>
        </div>
      </div>
    </div>
  );
}

// Sentiment icon helper (matches agent desktop)
function getSentimentIcon(sentiment) {
  const iconProps = { className: "size-3.5 shrink-0" };
  switch (sentiment) {
    case "positive":
      return <IconMoodSmile {...iconProps} />;
    case "negative":
      return <IconMoodSad {...iconProps} />;
    default:
      return <IconMoodNeutral {...iconProps} />;
  }
}

function getSentimentColor(sentiment) {
  switch (sentiment) {
    case "positive":
      return "text-green-600 dark:text-green-400";
    case "negative":
      return "text-red-500 dark:text-red-400";
    default:
      return "text-muted-foreground";
  }
}

// Message component with intent/sentiment badges (same as agent desktop)
function Message({ message, isUser, analysis }) {
  const sentiment = analysis?.sentiment;
  const sentimentScore = analysis?.sentimentScore;
  const intent = analysis?.intent;
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
            <p className="text-sm flex-1">{message.content}</p>
            {isManual && isUser && (
              <IconPencil
                className="size-3.5 shrink-0 mt-0.5 opacity-80"
                title="Manually provided (auto flow stopped)"
              />
            )}
          </div>
          <span className="text-xs opacity-70 mt-1 block">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>
        {/* Intent and sentiment badges (same as agent desktop) */}
        {(intent || sentiment) && (
          <div
            className={cn(
              "flex items-center gap-1.5 mt-1 flex-wrap",
              isUser ? "flex-row-reverse" : ""
            )}
          >
            {intent && (
              <Badge
                variant="outline"
                className="text-[10px] bg-purple-500/10 text-purple-500 border-purple-500/50 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-500/50"
              >
                <IconTarget className="size-3 mr-0.5" />
                {getIntentLabel(intent)}
              </Badge>
            )}
            {sentiment && (
              <div
                className={cn(
                  "flex items-center gap-0.5",
                  getSentimentColor(sentiment)
                )}
              >
                {getSentimentIcon(sentiment)}
                {typeof sentimentScore === "number" && (
                  <span className="text-[10px]">{sentimentScore}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// MOCK MICROPHONE FOR VOICE TESTS
// ============================================

class MockMicrophone {
  constructor() {
    this.audioContext = null;
    this.destination = null;
    this.stream = null;
    this.isPlaying = false;
  }

  async init() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });

    this.destination = this.audioContext.createMediaStreamDestination();
    this.stream = this.destination.stream;

    // Silent oscillator to keep stream active
    const oscillator = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(this.destination);
    oscillator.start();

    console.log("[MockMic] Initialized (48kHz)");
    return this.stream;
  }

  async injectAudio(audioBuffer) {
    if (!this.audioContext || !this.destination) {
      throw new Error("Mock microphone not initialized");
    }

    this.isPlaying = true;

    return new Promise((resolve, reject) => {
      try {
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.destination);

        source.onended = () => {
          this.isPlaying = false;
          resolve();
        };

        source.start();
        console.log(`[MockMic] Injecting ${audioBuffer.duration.toFixed(2)}s of audio`);
      } catch (err) {
        this.isPlaying = false;
        reject(err);
      }
    });
  }

  async injectAudioFromUrl(url) {
    console.log(`[MockMic] Loading audio from: ${url}`);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch audio: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

    return this.injectAudio(audioBuffer);
  }

  getStream() {
    return this.stream;
  }

  cleanup() {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.destination = null;
    this.stream = null;
  }
}

// ============================================
// TTS SERVICE FOR VOICE TESTS
// ============================================

async function generateTTS(text, voice) {
  console.log(`[TTS] Generating for: "${text.substring(0, 50)}..." with voice: ${voice}`);

  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice,
    }),
  });

  if (!response.ok) {
    throw new Error(`TTS server error: ${response.status}`);
  }

  const audioBlob = await response.blob();
  const audioUrl = URL.createObjectURL(audioBlob);

  console.log("[TTS] Audio generated");
  return audioUrl;
}

export default function TestAgentPage() {
  const router = useRouter();
  const params = useParams();
  const flowId = params.id;

  const [loading, setLoading] = useState(true);
  const [workflow, setWorkflow] = useState(null);
  const [selectedScenario, setSelectedScenario] = useState("workflow_specific");
  const [generatedScenario, setGeneratedScenario] = useState(null);
  const [channel, setChannel] = useState("chat"); // "chat" or "voice"
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
  const [isMuted, setIsMuted] = useState(false);
  const [localAudioEnabled, setLocalAudioEnabled] = useState(true);
  const [agentState, setAgentState] = useState("idle");
  const [hasReceivedWelcomeMessage, setHasReceivedWelcomeMessage] = useState(false);
  
  // TTS configuration
  const [ttsVoices, setTtsVoices] = useState({});
  const [ttsProvider, setTtsProvider] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");
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
  const [messageAnalysis, setMessageAnalysis] = useState({}); // index -> { intent, sentiment, sentimentScore }
  
  // Refs
  const messagesEndRef = useRef(null);
  const voiceClientRef = useRef(null);
  const audioContextRef = useRef(null);
  const mockMicRef = useRef(null); // Mock microphone for audio injection
  const remoteAudioRef = useRef(null); // Remote audio element for AI voice
  const autoModeRef = useRef(isAutoMode); // Track auto mode in ref for callbacks
  const isTestRunningRef = useRef(false); // Track test running for async stop checks
  const welcomeMessageReceivedRef = useRef(false); // Track if welcome message was received
  const currentStepRef = useRef(0); // Track current step in ref for voice callbacks
  const respondingInProgressRef = useRef(false); // Prevent double responses
  const localAudioEnabledRef = useRef(true); // Track local audio playback
  const ttsVoiceRef = useRef("Minimax.speech-2.8-turbo.English_magnetic_voiced_man"); // Current TTS voice
  const lastAnalyzedMessageIndexRef = useRef(-1);
  const workflowAnalysisInProgressRef = useRef(false);
  const scenarioFetchInProgressRef = useRef(false);
  const chatProcessingRef = useRef(false); // Prevent double processAIResponse in chat
  const selectedScenarioRef = useRef(selectedScenario);
  selectedScenarioRef.current = selectedScenario;

  // Wait for workflow analysis to complete before sending next message (so LLM can fill slots)
  const waitForAnalysisAndDelay = useCallback(async () => {
    // Let React commit so analysis useEffect can run and process new messages
    await new Promise((r) => setTimeout(r, 600));
    // Wait for analysis to finish (poll, max 15s)
    const maxWait = 15000;
    const pollInterval = 200;
    const start = Date.now();
    while (workflowAnalysisInProgressRef.current && Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    // Brief delay so workflow UI updates
    await new Promise((r) => setTimeout(r, 800));
  }, []);
  const workflowItemStatusesRef = useRef({});
  const workflowSlotsFilledRef = useRef({});
  const [analysisRetryTrigger, setAnalysisRetryTrigger] = useState(0);
  workflowItemStatusesRef.current = workflowItemStatuses;
  workflowSlotsFilledRef.current = workflowSlotsFilled;
  
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
    localAudioEnabledRef.current = localAudioEnabled;
  }, [localAudioEnabled]);

  // Load TTS voices from API
  useEffect(() => {
    async function loadVoices() {
      try {
        const res = await fetch("/api/tts/voices?language=en");
        const data = await res.json();
        if (data.ok && data.voices) {
          setTtsVoices(data.voices);
          // Set defaults
          const providers = Object.keys(data.voices);
          if (providers.length > 0) {
            const defaultProvider = providers.includes("minimax") ? "minimax" : providers[0];
            setTtsProvider(defaultProvider);
            const models = Object.keys(data.voices[defaultProvider] || {});
            if (models.length > 0) {
              setTtsModel(models[0]);
              const voices = data.voices[defaultProvider][models[0]] || [];
              if (voices.length > 0) {
                setTtsVoice(voices[0].name);
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

  // Reset model and voice when provider changes
  useEffect(() => {
    if (!ttsProvider || !ttsVoices[ttsProvider]) return;
    const models = Object.keys(ttsVoices[ttsProvider] || {});
    if (models.length > 0) {
      setTtsModel(models[0]);
      const voices = ttsVoices[ttsProvider][models[0]] || [];
      if (voices.length > 0) {
        setTtsVoice(voices[0].name);
        setTtsVoiceId(voices[0].id);
      }
    }
  }, [ttsProvider, ttsVoices]);

  // Reset voice when model changes  
  useEffect(() => {
    if (!ttsProvider || !ttsModel || !ttsVoices[ttsProvider]) return;
    const voices = ttsVoices[ttsProvider]?.[ttsModel] || [];
    if (voices.length > 0) {
      const currentVoice = voices.find(v => v.name === ttsVoice);
      if (!currentVoice) {
        setTtsVoice(voices[0].name);
        setTtsVoiceId(voices[0].id);
      }
    }
  }, [ttsModel, ttsProvider, ttsVoice, ttsVoices]);

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

  // LLM-generated scenario - all scenarios use same flow
  const [isScenarioGenerating, setIsScenarioGenerating] = useState(false);

  const fetchScenario = useCallback(async (scenarioType) => {
    if (!flowId) return null;
    // workflow_specific requires stages; others work with just workflow name
    if (scenarioType === "workflow_specific" && !workflow?.stages?.length) return null;
    scenarioFetchInProgressRef.current = true;
    setIsScenarioGenerating(true);
    setGeneratedScenario(null);
    try {
      const res = await fetch(`/api/admin/workflows/${flowId}/generate-test-scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ scenarioType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate scenario");
      // Only set if user hasn't switched to a different scenario during fetch
      if (data.scenario && selectedScenarioRef.current === data.scenario.id) {
        setGeneratedScenario(data.scenario);
      }
      return data.scenario;
    } catch (err) {
      notify({
        title: "Scenario generation failed",
        description: err.message,
        variant: "error",
      });
      return null;
    } finally {
      scenarioFetchInProgressRef.current = false;
      setIsScenarioGenerating(false);
    }
  }, [flowId, workflow?.stages?.length]);

  // Generate scenario when selection changes
  useEffect(() => {
    if (!selectedScenario || !flowId) return;
    if (selectedScenario === "workflow_specific" && !workflow?.stages?.length) return;
    fetchScenario(selectedScenario);
  }, [selectedScenario, flowId, workflow?.stages?.length, fetchScenario]);

  // Resolve current scenario - use generated or placeholder
  const scenarioConfig = SCENARIO_LIST.find((s) => s.id === selectedScenario);
  const currentScenario =
    generatedScenario && generatedScenario.id === selectedScenario
      ? generatedScenario
      : {
          id: selectedScenario,
          name: scenarioConfig?.name || selectedScenario,
          description: scenarioConfig?.description || "Generating…",
          responses: [],
        };

  // Available scenarios - Complete Workflow only when workflow has stages
  const availableScenarios = useMemo(() => {
    if (workflow?.stages?.length) {
      return SCENARIO_LIST;
    }
    return SCENARIO_LIST.filter((s) => s.id !== "workflow_specific");
  }, [workflow?.stages?.length]);

  // Ensure selectedScenario is valid; default to Complete Workflow when it becomes available
  const usedFallbackRef = useRef(false);
  useEffect(() => {
    const hasWorkflowSpecific = availableScenarios.some((s) => s.id === "workflow_specific");
    const valid = availableScenarios.some((s) => s.id === selectedScenario);

    if (!valid && availableScenarios.length > 0) {
      usedFallbackRef.current = true;
      setSelectedScenario(hasWorkflowSpecific ? "workflow_specific" : availableScenarios[0].id);
    } else if (hasWorkflowSpecific && usedFallbackRef.current) {
      // Recover: we had fallen back before workflow loaded, now switch to Complete Workflow
      usedFallbackRef.current = false;
      setSelectedScenario("workflow_specific");
    }
  }, [availableScenarios, selectedScenario]);
  const totalScenarioSteps = currentScenario?.responses?.length ?? 0;

  const workflowStages = workflow?.stages ?? [];
  const totalWorkflowItems = workflowStages.reduce(
    (sum, s) => sum + (s.items?.length ?? 0),
    0
  );
  const completedWorkflowItems = Object.values(workflowItemStatuses).filter(
    (s) => s?.status === "completed"
  ).length;

  // Analyze new messages with LLM (same approach as live agent desktop)
  useEffect(() => {
    if (!flowId || !workflow?.stages?.length || !isTestRunning) return;

    const analyzableMessages = messages
      .map((m, i) => ({ ...m, index: i }))
      .filter((m) => m.role !== "system" && m.content?.trim());
    const toAnalyze = analyzableMessages.filter(
      (m) => m.index > lastAnalyzedMessageIndexRef.current
    );
    if (toAnalyze.length === 0) return;

    if (workflowAnalysisInProgressRef.current) {
      // Analysis in progress, retry shortly so we process these messages when it finishes
      const t = setTimeout(() => setAnalysisRetryTrigger((r) => r + 1), 400);
      return () => clearTimeout(t);
    }

    let cancelled = false;
    workflowAnalysisInProgressRef.current = true;
    setIsAnalyzingWorkflow(true);

    (async () => {
      let statuses = { ...workflowItemStatusesRef.current };
      let slots = { ...workflowSlotsFilledRef.current };

      for (const msg of toAnalyze) {
        if (cancelled) break;
        const speaker = msg.role === "user" ? "customer" : "agent";
        try {
          const result = await analyzeWorkflowMessage(
            flowId,
            msg.content,
            speaker,
            statuses,
            slots
          );
          if (result.updates?.length) {
            for (const u of result.updates) {
              if (u.status === "completed") {
                statuses = {
                  ...statuses,
                  [u.item_id]: {
                    status: "completed",
                    extracted_value: u.extracted_value,
                    value: u.extracted_value,
                    confidence_score: u.confidence,
                  },
                };
              }
            }
          }
          if (result.slotsFilled && Object.keys(result.slotsFilled).length > 0) {
            slots = { ...slots, ...result.slotsFilled };
          }
          // Store intent/sentiment for message display (same as agent desktop)
          if (result.intent || result.sentiment) {
            setMessageAnalysis((prev) => ({
              ...prev,
              [msg.index]: {
                intent: result.intent,
                sentiment: result.sentiment,
                sentimentScore: result.sentimentScore,
              },
            }));
          }
        } catch (err) {
          console.error("[Workflow Test] Analyze error:", err);
        }
        lastAnalyzedMessageIndexRef.current = msg.index;
      }

      if (!cancelled) {
        setWorkflowItemStatuses(statuses);
        setWorkflowSlotsFilled(slots);
      }
      workflowAnalysisInProgressRef.current = false;
      setIsAnalyzingWorkflow(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [flowId, workflow?.stages?.length, isTestRunning, messages, analysisRetryTrigger]);

  // Send chat message via REST API
  const sendChatMessage = useCallback(async (messageText, convId, stepIndex = null, options = {}) => {
    if (!agentId || !convId) return null;
    
    setSendingMessage(true);
    
    // Add user message to UI
    setMessages((prev) => [
      ...prev,
      {
        id: uniqueMessageId("user"),
        role: "user",
        content: messageText,
        timestamp: new Date().toISOString(),
        manual: options.manual === true,
      },
    ]);

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
      
      // Add AI response to UI
      setMessages((prev) => [
        ...prev,
        {
          id: uniqueMessageId("ai"),
          role: "assistant",
          content: aiContent,
          timestamp: new Date().toISOString(),
        },
      ]);
      
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
  }, [agentId]);

  // Process AI response and send next scenario step if in auto mode
  const processAIResponse = useCallback(async (aiContent, convId, currentStepIndex) => {
    if (!autoModeRef.current || isPaused || !isTestRunningRef.current) return;
    if (chatProcessingRef.current) return; // Prevent double processing
    chatProcessingRef.current = true;
    try {
    const scenario = currentScenario;
    if (!scenario?.responses?.length) return;

    const lowerMessage = (aiContent || "").toLowerCase();

    // Collectible workflow items (same order as scenario for workflow_specific)
    const collectibleItems = selectedScenarioRef.current === "workflow_specific"
      ? (workflow?.stages?.flatMap((s) => s.items ?? [])
          .filter((item) => (item.item_type || item.type || "action") !== "action") ?? [])
      : [];

    /** Extract significant words (length > 2) from label, prompt_hint, slot_name for matching */
    const getItemWords = (item) => {
      if (!item) return [];
      const parts = [
        item.label,
        item.name,
        item.prompt_hint,
        item.slot_name?.replace(/_/g, " "),
      ].filter(Boolean);
      const text = parts.join(" ");
      return [...new Set(text.toLowerCase().split(/[\s,;:|]+/).filter((w) => w.length > 2))];
    };

    // Find BEST matching step: prefer keyword match, then label/prompt_hint match
    // NOTE: For workflow_specific, scenario.responses[0] is greeting (waitForGreeting),
    // responses[1+] correspond to collectibleItems[0+]. So item index = response index - 1.
    let bestStep = null;
    let bestScore = 0;
    for (let i = currentStepIndex; i < scenario.responses.length; i++) {
      const step = scenario.responses[i];
      
      // Map response index to collectible item index (responses[0] = greeting, no item)
      const itemIndex = i > 0 ? i - 1 : null;
      const item = itemIndex !== null ? collectibleItems[itemIndex] : null;

      // Skip if workflow_specific and this step's item is already completed
      if (item?.id && workflowItemStatusesRef.current?.[item.id]?.status === "completed") {
        continue;
      }

      // Try keyword match first
      const matchCount = step.keywords?.length
        ? step.keywords.filter((kw) => lowerMessage.includes(String(kw).toLowerCase())).length
        : 0;

      // Fallback: match workflow item label/prompt_hint (handles e.g. "Callback number" when AI says "confirm your callback number")
      let itemMatchCount = 0;
      if (matchCount === 0 && item) {
        const itemWords = getItemWords(item);
        itemMatchCount = itemWords.filter((w) => lowerMessage.includes(w)).length;
      }

      const totalMatch = matchCount || itemMatchCount;
      if (totalMatch === 0) continue;

      const score = totalMatch * 1000 + i;
      if (score > bestScore) {
        bestScore = score;
        bestStep = { index: i, step };
      }
    }

    // Fallback: when no match, use next step in sequence (AI phrasing may differ)
    let stepToUse = bestStep;
    if (!stepToUse && currentStepIndex < scenario.responses.length) {
      const nextStep = scenario.responses[currentStepIndex];
      // Map response index to collectible item index
      const itemIndex = currentStepIndex > 0 ? currentStepIndex - 1 : null;
      const item = itemIndex !== null ? collectibleItems[itemIndex] : null;
      const itemCompleted = item?.id && workflowItemStatusesRef.current?.[item.id]?.status === "completed";
      if (nextStep?.text?.trim() && !itemCompleted) {
        stepToUse = { index: currentStepIndex, step: nextStep };
      }
    }

    if (stepToUse) {
      const { index: i, step } = stepToUse;
      setCurrentStep(i + 1);

      await waitForAnalysisAndDelay();
      if (!isTestRunningRef.current) return;

      const nextResponse = await sendChatMessage(step.text, convId, i);
      if (!isTestRunningRef.current) return;

      if (i >= scenario.responses.length - 1) {
        setMessages((prev) => [
          ...prev,
          {
            id: "system-complete",
            role: "system",
            content: "✅ Test scenario completed successfully!",
            timestamp: new Date().toISOString(),
          },
        ]);
        return;
      }

      if (nextResponse) {
        await processAIResponse(nextResponse, convId, i + 1);
      }
    }
    } finally {
      chatProcessingRef.current = false;
    }
  }, [currentScenario, isPaused, workflow, sendChatMessage, waitForAnalysisAndDelay]);

  // Create a new conversation via Telnyx API
  const createConversation = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Test: ${currentScenario.name}`,
          metadata: {
            test_scenario: selectedScenario,
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
  }, [currentScenario, selectedScenario, agentId]);

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
    setMessages([]);
    setMessageAnalysis({});
    setCurrentStep(0);
    currentStepRef.current = 0;
    lastAnalyzedMessageIndexRef.current = -1;
    setWorkflowItemStatuses({});
    setWorkflowSlotsFilled({});
    setAgentState("active");

    // Add system message
    setMessages([
      {
        id: "system-start",
        role: "system",
        content: `Starting chat test: ${currentScenario.name} (REST API)`,
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      // Step 1: Send "Hello" to get welcome message from AI
      const welcomeResponse = await sendChatMessage("Hello", newConversationId);
      
      if (!welcomeResponse) {
        throw new Error("No welcome message from AI");
      }

      // Wait for workflow analysis of welcome exchange before sending first scenario message
      await waitForAnalysisAndDelay();

      // Step 2: Send first scenario message
      const firstStep = currentScenario.responses[0];
      if (!firstStep) {
        throw new Error("No messages in scenario");
      }

      setCurrentStep(1);
      const firstResponse = await sendChatMessage(firstStep.text, newConversationId);
      
      if (!firstResponse) {
        throw new Error("No response from AI");
      }

      // In auto mode, continue with remaining messages
      if (isAutoMode && currentScenario.responses.length > 1) {
        await processAIResponse(firstResponse, newConversationId, 1);
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
  }, [agentId, currentScenario, isAutoMode, sendChatMessage, processAIResponse, createConversation, waitForAnalysisAndDelay]);

  // Send scenario message (manual mode) - uses REST API for chat, WebRTC for voice
  const sendScenarioMessage = useCallback(
    async (stepIndex) => {
      const scenario = currentScenario;
      if (!scenario || stepIndex >= scenario.responses.length) {
        setMessages((prev) => [
          ...prev,
          {
            id: "system-complete",
            role: "system",
            content: "✅ Test scenario completed successfully!",
            timestamp: new Date().toISOString(),
          },
        ]);
        return;
      }

      const step = scenario.responses[stepIndex];
      
      if (channel === "chat" && conversationId) {
        // Chat mode - use REST API
        await sendChatMessage(step.text, conversationId, stepIndex);
        setCurrentStep(stepIndex + 1);
      } else if (voiceClientRef.current) {
        // Voice mode - use WebRTC
        voiceClientRef.current.sendConversationMessage(step.text);
        setMessages((prev) => [
          ...prev,
          {
            id: uniqueMessageId("user"),
            role: "user",
            content: step.text,
            timestamp: new Date().toISOString(),
          },
        ]);
        setCurrentStep(stepIndex + 1);
      }
    },
    [currentScenario, channel, conversationId, sendChatMessage]
  );

  // Send manual message - uses REST API for chat, WebRTC for voice
  const sendMessage = useCallback(async () => {
    if (!inputMessage.trim() || sendingMessage) return;

    const messageText = inputMessage.trim();
    setInputMessage("");
    
    if (channel === "chat" && conversationId) {
      // Chat mode - use REST API (mark as manual - user typed because auto flow stopped)
      const response = await sendChatMessage(messageText, conversationId, undefined, { manual: true });
      // In auto mode, process the response for next steps
      if (isAutoMode && response) {
        await processAIResponse(response, conversationId, currentStep);
      }
    } else if (voiceClientRef.current) {
      // Voice mode - use WebRTC
      voiceClientRef.current.sendConversationMessage(messageText);
      setMessages((prev) => [
        ...prev,
        {
          id: uniqueMessageId("user"),
          role: "user",
          content: messageText,
          timestamp: new Date().toISOString(),
          manual: true,
        },
      ]);
    }
  }, [inputMessage, sendingMessage, channel, conversationId, sendChatMessage, isAutoMode, processAIResponse, currentStep]);

  // Stop test - also clear conversation so no further messages can be sent
  const stopTest = useCallback(() => {
    chatProcessingRef.current = false;
    isTestRunningRef.current = false;
    setIsTestRunning(false);
    setIsPaused(false);
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

    // Clean up voice if active
    if (voiceClientRef.current) {
      try {
        voiceClientRef.current.endConversation?.();
        voiceClientRef.current.disconnect?.();
      } catch (e) {
        // Ignore cleanup errors
      }
      voiceClientRef.current = null;
    }
    
    // Clean up mock microphone
    if (mockMicRef.current) {
      mockMicRef.current.cleanup();
      mockMicRef.current = null;
    }
    
    setVoiceStatus("idle");
  }, []);

  // Reset test - regenerate scenario for current selection
  const resetTest = useCallback(() => {
    chatProcessingRef.current = false;
    isTestRunningRef.current = false;
    setIsTestRunning(false);
    setIsPaused(false);
    setConversationId(null);
    setMessages([]);
    setMessageAnalysis({});
    setCurrentStep(0);
    currentStepRef.current = 0;
    lastAnalyzedMessageIndexRef.current = -1;
    workflowAnalysisInProgressRef.current = false;
    setWorkflowItemStatuses({});
    setWorkflowSlotsFilled({});
    fetchScenario(selectedScenario);
    setVoiceStatus("idle");
    setAgentState("idle");
    setHasReceivedWelcomeMessage(false);
    welcomeMessageReceivedRef.current = false;
    respondingInProgressRef.current = false;
    
    // Clean up mock microphone
    if (mockMicRef.current) {
      mockMicRef.current.cleanup();
      mockMicRef.current = null;
    }
  }, [selectedScenario, fetchScenario]);

  // Speak text via TTS and inject into mock microphone
  const speakTextViaAudio = useCallback(async (text) => {
    if (!mockMicRef.current) {
      console.error("[Voice] Mock mic not initialized");
      return;
    }

    try {
      // Add to messages immediately
      setMessages((prev) => [
        ...prev,
        {
          id: uniqueMessageId("user"),
          role: "user",
          content: text,
          timestamp: new Date().toISOString(),
        },
      ]);

      // Generate TTS audio with selected voice
      const audioUrl = await generateTTS(text, ttsVoiceRef.current);

      // Inject into mock microphone stream
      await mockMicRef.current.injectAudioFromUrl(audioUrl);

      // Also play locally so we can hear our side
      if (localAudioEnabledRef.current) {
        const localAudio = new Audio(audioUrl);
        localAudio.volume = 0.7;
        localAudio.play().catch((e) => console.warn("[Voice] Local playback error:", e));
      }

      // Cleanup after a delay
      setTimeout(() => URL.revokeObjectURL(audioUrl), 10000);

      console.log("[Voice] Audio injected successfully");
    } catch (err) {
      console.error("[Voice] Failed to speak:", err);
      notify({
        title: "TTS Error",
        description: err.message,
        variant: "error",
      });
    }
  }, []);

  // Handle auto-response when AI finishes speaking
  const handleVoiceAutoResponse = useCallback(async () => {
    if (!autoModeRef.current || respondingInProgressRef.current) return;
    if (currentStepRef.current >= currentScenario.responses.length) {
      console.log("[Voice] All steps completed!");
      setMessages((prev) => [
        ...prev,
        {
          id: "system-complete",
          role: "system",
          content: "✅ Test scenario completed successfully!",
          timestamp: new Date().toISOString(),
        },
      ]);
      return;
    }

    respondingInProgressRef.current = true;

    const step = currentScenario.responses[currentStepRef.current];
    console.log(`[Voice] Step ${currentStepRef.current + 1}/${currentScenario.responses.length}: "${step.text}"`);

    setCurrentStep((prev) => prev + 1);
    
    // Speak the response (this waits for audio injection to complete)
    await speakTextViaAudio(step.text);
    
    // Wait additional time for the audio to be processed by AI
    // This prevents overlapping with the next AI response
    await new Promise((r) => setTimeout(r, 4000));

    respondingInProgressRef.current = false;
  }, [currentScenario, speakTextViaAudio]);

  // Start voice test with audio injection
  const startVoiceTest = useCallback(async () => {
    if (!agentId) {
      notify({
        title: "No Assistant Selected",
        description: "Please select or create an AI assistant first.",
        variant: "error",
      });
      return;
    }

    setIsTestRunning(true);
    setVoiceStatus("connecting");
    setHasReceivedWelcomeMessage(false);
    welcomeMessageReceivedRef.current = false;
    respondingInProgressRef.current = false;
    setCurrentStep(0);
    currentStepRef.current = 0;
    lastAnalyzedMessageIndexRef.current = -1;
    setWorkflowItemStatuses({});
    setWorkflowSlotsFilled({});
    setMessages([
      {
        id: "system-voice-start",
        role: "system",
        content: `Starting voice test with audio injection: ${currentScenario.name}`,
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      // Initialize mock microphone
      console.log("[Voice] Initializing mock microphone...");
      const mockMic = new MockMicrophone();
      await mockMic.init();
      mockMicRef.current = mockMic;

      // Override getUserMedia to return our mock stream
      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints.audio) {
          console.log("[Voice] getUserMedia intercepted - returning mock stream");
          return mockMic.getStream();
        }
        return originalGetUserMedia(constraints);
      };

      // Dynamic import of TelnyxAIAgent (using v0.1.9 for unauthenticated calls)
      const { TelnyxAIAgent } = await import("@telnyx/ai-agent-lib");

      const client = new TelnyxAIAgent({
        agentId: agentId,
        debug: true,
      });

      voiceClientRef.current = client;
      let lastAgentState = null;

      // Set up event handlers
      client.on("agent.connected", () => {
        setVoiceStatus("active");
        setMessages((prev) => [
          ...prev,
          {
            id: "system-connected",
            role: "system",
            content: "✅ Connected to AI Agent (audio injection mode)",
            timestamp: new Date().toISOString(),
          },
        ]);
      });

      client.on("agent.disconnected", () => {
        setVoiceStatus("idle");
        setIsTestRunning(false);
        // Cleanup mock mic
        if (mockMicRef.current) {
          mockMicRef.current.cleanup();
          mockMicRef.current = null;
        }
      });

      client.on("agent.error", (err) => {
        setVoiceStatus("error");
        let errorMessage = "An unknown error occurred";
        
        if (err) {
          if (typeof err === 'string') {
            errorMessage = err;
          } else if (err.message) {
            errorMessage = err.message;
          } else if (err.description) {
            errorMessage = err.description;
          } else if (err.error?.message) {
            errorMessage = err.error.message;
          } else if (typeof err === 'object') {
            if (err.code && err.message) {
              errorMessage = `Error ${err.code}: ${err.message}`;
            } else {
              errorMessage = JSON.stringify(err);
            }
          } else {
            errorMessage = String(err);
          }
        }
        
        notify({
          title: "Voice Error",
          description: errorMessage,
          variant: "error",
        });
        console.error("[Voice Test] Agent error:", err);
      });

      // Handle agent state changes for auto-response
      client.on("conversation.agent.state", (state) => {
        const prevState = lastAgentState;
        lastAgentState = state;
        setAgentState(state);

        console.log(`[Voice] Agent: ${prevState || "init"} → ${state}`);

        if (state === "speaking") {
          // Mark greeting received when AI starts speaking for the first time
          if (!welcomeMessageReceivedRef.current) {
            welcomeMessageReceivedRef.current = true;
            setHasReceivedWelcomeMessage(true);
            console.log("[Voice] AI started speaking (greeting)");
          }
        } else if (state === "listening") {
          // Auto-respond after AI finishes speaking (speaking → listening transition)
          if (prevState === "speaking" && welcomeMessageReceivedRef.current) {
            // Wait for AI to be ready to listen before responding
            // Longer delay prevents message overlap
            setTimeout(() => {
              handleVoiceAutoResponse();
            }, 3000);
          }
        }
      });

      client.on("transcript.item", (item) => {
        const isAssistant = item.role === "assistant";
        
        setMessages((prev) => [
          ...prev,
          {
            id: item.id || uniqueMessageId("transcript"),
            role: isAssistant ? "assistant" : "user",
            content: item.content,
            timestamp: new Date().toISOString(),
          },
        ]);
      });

      // Handle conversation updates to connect remote audio stream
      client.on("conversation.update", (conv) => {
        if (conv?.call?.state === "active") {
          console.log("[Voice] Call is active");
          
          // Connect remote audio stream so we can hear AI
          if (conv.call.remoteStream && remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = conv.call.remoteStream;
            console.log("[Voice] Remote audio stream connected");
          }
        }
      });

      await client.connect();
      await new Promise((r) => setTimeout(r, 1000));

      await client.startConversation({
        callerName: "Voice Test Harness",
        audio: true,
      });

      console.log("[Voice] Conversation started - waiting for AI greeting...");
    } catch (err) {
      setVoiceStatus("error");
      setIsTestRunning(false);
      
      // Cleanup mock mic on error
      if (mockMicRef.current) {
        mockMicRef.current.cleanup();
        mockMicRef.current = null;
      }
      
      let errorMessage = "An unknown error occurred";
      if (err) {
        if (typeof err === 'string') {
          errorMessage = err;
        } else if (err.message) {
          errorMessage = err.message;
        } else if (err.description) {
          errorMessage = err.description;
        } else if (err.error?.message) {
          errorMessage = err.error.message;
        } else if (typeof err === 'object') {
          if (err.code && err.message) {
            errorMessage = `Error ${err.code}: ${err.message}`;
          } else {
            errorMessage = JSON.stringify(err);
          }
        } else {
          errorMessage = String(err);
        }
      }
      
      notify({
        title: "Failed to start voice test",
        description: errorMessage,
        variant: "error",
      });
      console.error("[Voice Test] Failed to start:", err);
    }
  }, [agentId, currentScenario, handleVoiceAutoResponse]);

  if (loading) {
    return (
      <div className="p-4">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <IconRobot className="h-5 w-5 text-telnyx-green" />
              Test AI Agent
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-[600px] w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="px-0 lg:px-6 py-0">
      {/* Hidden audio element for AI voice playback */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />
      
      <Card className="w-full shadow-sm flex flex-col overflow-hidden" style={{ height: "90vh" }}>
        <CardHeader className="flex flex-row items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/admin/workflows/${flowId}`)}
            >
              <IconArrowLeft className="size-4 mr-2" />
              Back to Workflow
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <IconRobot className="h-5 w-5 text-telnyx-green" />
              Test AI Agent
            </CardTitle>
            <div className="text-sm text-muted-foreground">
              {workflow?.name || "Workflow"}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 md:p-6 h-full flex flex-col overflow-hidden">
          <div className="flex h-full min-h-0 gap-6">
          {/* Left: narrow config panel as Card */}
          <Card className="w-64 shrink-0 flex flex-col overflow-hidden">
            <div className="shrink-0 border-b px-4 py-3 mb-4">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <IconSettings className="size-4 text-blue-500" />
                Configuration
              </h3>
              <p className="text-xs text-muted-foreground mt-1">Test setup and controls</p>
            </div>
            <CardContent className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Model</label>
                <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
                  {workflow?.llm_model || "openai/gpt-4o"}
                </div>
              </div>
              <div className="space-y-4">
                {/* AI Assistant (from workflow config) */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">AI Assistant</label>
                  <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
                    {agentId ? (
                      assistantName ? (
                        assistantName
                      ) : (
                        <span className="text-muted-foreground">Loading…</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">Not assigned</span>
                    )}
                  </div>
                  {!agentId && (
                    <p className="text-xs text-muted-foreground">
                      Create an AI Agent from the workflow page and assign it to this workflow.
                    </p>
                  )}
                </div>

                {/* Scenario Selection */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Test Scenario</label>
                  <Select
                    value={selectedScenario}
                    onValueChange={setSelectedScenario}
                    disabled={isTestRunning}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableScenarios.map((scenario) => (
                        <SelectItem key={scenario.id} value={scenario.id}>
                          {scenario.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {currentScenario?.description}
                  </p>
                </div>

                {/* Channel Selection */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Channel</label>
                  <Tabs value={channel} onValueChange={setChannel}>
                    <TabsList className="w-full">
                      <TabsTrigger value="chat" className="flex-1">
                        <IconMessageCircle className="size-4 mr-2" />
                        Chat
                      </TabsTrigger>
                      <TabsTrigger value="voice" className="flex-1">
                        <IconPhone className="size-4 mr-2" />
                        Voice
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>

                {/* Auto Mode Toggle */}
                <div className="flex items-center justify-between">
                  <Label htmlFor="auto-mode" className="text-sm font-medium cursor-pointer">
                    Auto Mode
                  </Label>
                  <Switch
                    id="auto-mode"
                    checked={isAutoMode}
                    onCheckedChange={setIsAutoMode}
                    disabled={isTestRunning}
                  />
                </div>

                {/* TTS Configuration (Voice channel only) */}
                {channel === "voice" && (
                  <div className="space-y-3 pt-3 border-t">
                    <label className="text-sm font-medium">TTS Voice</label>
                    
                    {/* Provider */}
                    <Select
                      value={ttsProvider}
                      onValueChange={setTtsProvider}
                      disabled={isTestRunning}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Provider" />
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
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Model" />
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
                    <Select
                      value={ttsVoice}
                      onValueChange={(name) => {
                        const voices = ttsVoices[ttsProvider]?.[ttsModel] || [];
                        const voice = voices.find(v => v.name === name);
                        setTtsVoice(name);
                        if (voice) setTtsVoiceId(voice.id);
                      }}
                      disabled={isTestRunning}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Voice" />
                      </SelectTrigger>
                      <SelectContent>
                        {(ttsVoices[ttsProvider]?.[ttsModel] || []).map((voice) => (
                          <SelectItem key={voice.id} value={voice.name}>
                            {voice.name} {voice.gender ? `(${voice.gender})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

            <div className="pt-2 border-t">
              <h3 className="text-sm font-semibold mb-2">Controls</h3>
              <Badge
                variant="outline"
                className={cn(
                  "mb-3 w-full justify-center py-1 text-sm font-medium",
                  isScenarioGenerating
                    ? "border-amber-500 text-amber-600 dark:border-amber-400 dark:text-amber-400"
                    : isTestRunning
                    ? "border-green-500 text-green-600 dark:border-green-400 dark:text-green-400"
                    : generatedScenario && generatedScenario.id === selectedScenario
                    ? "border-emerald-500 text-emerald-600 dark:border-emerald-400 dark:text-emerald-400"
                    : "border-muted-foreground/60 text-muted-foreground"
                )}
              >
                {isScenarioGenerating ? (
                  <>
                    <IconLoader2 className="size-3 animate-spin mr-1.5" />
                    Generating scenario…
                  </>
                ) : isTestRunning ? (
                  "Test Running"
                ) : generatedScenario && generatedScenario.id === selectedScenario ? (
                  <>
                    <IconCheck className="size-3 mr-1.5" />
                    Scenario ready
                  </>
                ) : (
                  "Ready"
                )}
              </Badge>
              <div className="space-y-3">
                {!isTestRunning ? (
                  <Button
                    className="w-full"
                    onClick={channel === "chat" ? startChatTest : startVoiceTest}
                    disabled={
                      !agentId ||
                      isScenarioGenerating ||
                      !generatedScenario ||
                      generatedScenario.id !== selectedScenario
                    }
                  >
                    <IconPlayerPlay className="size-4 mr-2" />
                    Start Test
                  </Button>
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
                            <IconPlayerPlay className="size-4 mr-2" />
                            Resume
                          </>
                        ) : (
                          <>
                            <IconPlayerStop className="size-4 mr-2" />
                            Pause
                          </>
                        )}
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      className="w-full"
                      onClick={stopTest}
                    >
                      <IconX className="size-4 mr-2" />
                      Stop Test
                    </Button>
                  </>
                )}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={resetTest}
                >
                  <IconRefresh className="size-4 mr-2" />
                  Reset
                </Button>
              </div>
            </div>

            {isTestRunning && channel === "voice" && (
              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3">Voice Status</h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        voiceStatus === "active"
                          ? "default"
                          : voiceStatus === "connecting"
                          ? "secondary"
                          : voiceStatus === "error"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {voiceStatus}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      Agent: {agentState}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsMuted(!isMuted)}
                    >
                      {isMuted ? (
                        <IconMicrophoneOff className="size-4" />
                      ) : (
                        <IconMicrophone className="size-4" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setLocalAudioEnabled(!localAudioEnabled)}
                    >
                      {localAudioEnabled ? (
                        <IconVolume className="size-4" />
                      ) : (
                        <IconVolumeOff className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}
            </CardContent>
          </Card>

          {/* Middle: Agent View (50%) + Conversation (50%) as separate Cards */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0 gap-6">
            <div className="flex-1 grid grid-cols-2 gap-6 min-h-0">
              {/* Workflow Card */}
              <Card className="flex flex-col min-h-0 overflow-hidden">
                <div className="shrink-0 border-b px-4 py-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <IconClipboardList className="size-4 text-purple-500" />
                    Workflow
                    {isAnalyzingWorkflow && (
                      <Badge variant="outline" className="ml-auto text-xs animate-pulse bg-purple-500/10 text-purple-500 border-purple-500/50">
                        <IconLoader2 className="size-3 mr-1 animate-spin" />
                        Analyzing
                      </Badge>
                    )}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    LLM analyzes conversation for intent & slot extraction
                  </p>
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
                        <IconMessageCircle className="size-4 text-green-500" />
                        Simulated Conversation
                      </>
                    ) : (
                      <>
                        <IconPhone className="size-4 text-green-500" />
                        Simulated Conversation
                      </>
                    )}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Chat or voice messages from the test run
                  </p>
                </div>
                <CardContent className="flex-1 flex flex-col overflow-hidden p-0 min-h-0">
                {/* Messages Area */}
                <div className="flex-1 min-h-0 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="space-y-1 py-4 px-4">
                    {messages.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full text-center py-12">
                        <IconRobot className="size-12 text-muted-foreground/50 mb-4" />
                        <p className="text-sm text-muted-foreground">
                          No messages yet
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Click "Start Test" to begin
                        </p>
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
                            analysis={messageAnalysis[idx]}
                          />
                        );
                      })
                    )}
                    {sendingMessage && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <IconLoader2 className="size-4 animate-spin" />
                        <span className="text-sm">AI is typing...</span>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                    </div>
                  </ScrollArea>
                </div>

                {/* Input Area (Chat only) */}
                {channel === "chat" && (
                  <div className="shrink-0 border-t p-4">
                    <div className="flex gap-2">
                      <Input
                        value={inputMessage}
                        onChange={(e) => setInputMessage(e.target.value)}
                        placeholder="Type a message..."
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                          }
                        }}
                        disabled={!isTestRunning || sendingMessage}
                      />
                      <Button
                        onClick={sendMessage}
                        disabled={!isTestRunning || sendingMessage || !inputMessage.trim()}
                      >
                        <IconSend className="size-4" />
                      </Button>
                    </div>
                    {!isAutoMode && isTestRunning && currentScenario?.responses?.length > 0 && (
                      <div className="mt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => {
                            const stepIndex = findScenarioStepForLastAiMessage(
                              messages,
                              currentScenario,
                              workflowStages,
                              workflowItemStatuses
                            );
                            sendScenarioMessage(stepIndex);
                          }}
                        >
                          Send Next Scenario Response
                        </Button>
                      </div>
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
                totalScenarioSteps={totalScenarioSteps}
              />
            </div>
          </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
