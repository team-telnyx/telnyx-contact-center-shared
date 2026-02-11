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
            Turn {currentStep}
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
    this.silentOscillator = null;
    this.silentGain = null;
  }

  async init() {
    // Create AudioContext at 48kHz (WebRTC standard for Opus codec)
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });

    // Resume context if suspended (browser autoplay policy)
    if (this.audioContext.state === 'suspended') {
      console.log("[MockMic] AudioContext suspended, resuming...");
      await this.audioContext.resume();
    }

    // Create destination that produces a MediaStream
    this.destination = this.audioContext.createMediaStreamDestination();
    this.stream = this.destination.stream;

    // Create a constant low-level tone to keep the stream "alive"
    // WebRTC needs continuous audio data flow
    this.silentOscillator = this.audioContext.createOscillator();
    this.silentOscillator.type = 'sine';
    this.silentOscillator.frequency.value = 100; // 100 Hz tone
    
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0.001; // Barely audible
    
    this.silentOscillator.connect(this.silentGain);
    this.silentGain.connect(this.destination);
    this.silentOscillator.start();

    console.log(`[MockMic] Initialized (48kHz), AudioContext state: ${this.audioContext.state}`);
    
    // Debug: Monitor stream activity
    const track = this.stream.getAudioTracks()[0];
    console.log(`[MockMic] Audio track: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
    
    return this.stream;
  }
  
  // Method to verify stream is active
  debugStreamStatus() {
    if (!this.stream) return "No stream";
    const track = this.stream.getAudioTracks()[0];
    if (!track) return "No audio track";
    return `enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`;
  }

  async injectAudio(audioBuffer) {
    if (!this.audioContext || !this.destination) {
      throw new Error("Mock microphone not initialized");
    }

    this.isPlaying = true;

    // Analyze audio level
    const channelData = audioBuffer.getChannelData(0);
    let maxLevel = 0;
    let sumSquares = 0;
    for (let i = 0; i < channelData.length; i++) {
      const sample = Math.abs(channelData[i]);
      if (sample > maxLevel) maxLevel = sample;
      sumSquares += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sumSquares / channelData.length);
    console.log(`[MockMic] Audio analysis: duration=${audioBuffer.duration.toFixed(2)}s, sampleRate=${audioBuffer.sampleRate}Hz, channels=${audioBuffer.numberOfChannels}, maxLevel=${maxLevel.toFixed(4)}, RMS=${rms.toFixed(4)}`);

    return new Promise((resolve, reject) => {
      try {
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        
        // Add gain node for potential amplification
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = 1.0; // Can increase if needed
        
        source.connect(gainNode);
        gainNode.connect(this.destination);

        source.onended = () => {
          this.isPlaying = false;
          console.log(`[MockMic] Audio injection completed`);
          resolve();
        };

        source.start();
        console.log(`[MockMic] Injecting ${audioBuffer.duration.toFixed(2)}s of audio via gain node`);
        console.log(`[MockMic] Stream status: ${this.debugStreamStatus()}`);
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
    // Stop silent oscillator
    if (this.silentOscillator) {
      try {
        this.silentOscillator.stop();
      } catch (e) {
        // Ignore if already stopped
      }
      this.silentOscillator = null;
    }
    this.silentGain = null;
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.destination = null;
    this.stream = null;
    
    console.log("[MockMic] Cleaned up");
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
  const [channel, setChannel] = useState("chat"); // "chat" or "voice"
  
  // Dynamic response generation (on-the-fly customer simulation)
  const [selectedPersona, setSelectedPersona] = useState("cooperative");
  const [customerData, setCustomerData] = useState(null); // Persisted fake data for this test session
  const [isGeneratingResponse, setIsGeneratingResponse] = useState(false); // Show "Customer is thinking..." indicator
  const [voiceResponseDelay, setVoiceResponseDelay] = useState(3000); // Delay before generating voice response (ms)
  const [isMuted, setIsMuted] = useState(false); // Microphone mute state (MANUAL mode)
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
  const activeCallRef = useRef(null); // Store active call for mute/unmute
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
  const chatProcessingRef = useRef(false); // Prevent double processAIResponse in chat
  const customerDataRef = useRef(null); // Persist customer data across async calls
  customerDataRef.current = customerData;
  const messagesRef = useRef([]); // Track messages for async access without stale closures
  messagesRef.current = messages;

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
          filledSlots: workflowSlotsFilledRef.current,
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
  }, [flowId, selectedPersona]);

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

  // Persona descriptions for UI
  const PERSONA_DESCRIPTIONS = {
    cooperative: "Friendly customer who answers questions directly",
    frustrated: "Impatient customer, but still provides info",
    confused: "Sometimes misunderstands, asks for clarification",
    wants_transfer: "Prefers talking to a human agent",
    verbose: "Talkative, provides extra context",
  };

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

  // Process AI response and send next customer response if in auto mode
  const processAIResponse = useCallback(async (aiContent, convId, currentStepIndex) => {
    if (!autoModeRef.current || isPaused || !isTestRunningRef.current) return;
    
    try {
      // Dynamic response generation loop
      let currentAiMessage = aiContent;
      let stepNum = currentStepIndex;
      const MAX_TURNS = 50; // Safety limit to prevent infinite loops
      
      // Phrases that indicate conversation is ending
      const ENDING_PHRASES = [
        "goodbye", "good bye", "bye", "have a great day", "have a nice day",
        "take care", "thank you for calling", "thanks for calling",
        "end the call", "ending the call", "disconnect", "hanging up",
        "is there anything else", "anything else i can help",
      ];
      
      // Check if message indicates conversation ending
      const isConversationEnding = (message) => {
        if (!message) return false;
        const lower = message.toLowerCase();
        return ENDING_PHRASES.some(phrase => lower.includes(phrase));
      };
      
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (!isTestRunningRef.current || isPaused) {
          console.log("[Dynamic] Test stopped or paused");
          break;
        }
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

        await waitForAnalysisAndDelay();
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
  }, [isPaused, sendChatMessage, waitForAnalysisAndDelay, generateDynamicResponse]);

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
    setMessages([]);
    setMessageAnalysis({});
    setCurrentStep(0);
    currentStepRef.current = 0;
    lastAnalyzedMessageIndexRef.current = -1;
    setWorkflowItemStatuses({});
    setWorkflowSlotsFilled({});
    setCustomerData(null); // Reset customer data for new test session
    setAgentState("active");

    // Add system message
    setMessages([
      {
        id: "system-start",
        role: "system",
        content: `Starting chat test: ${selectedPersona} persona (REST API)`,
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
      await waitForAnalysisAndDelay();

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
  }, [agentId, isAutoMode, sendChatMessage, processAIResponse, createConversation, waitForAnalysisAndDelay, selectedPersona, generateDynamicResponse]);

  // Speak text via TTS and inject into mock microphone
  const speakTextViaAudio = useCallback(async (text) => {
    if (!mockMicRef.current) {
      console.error("[Voice] Mock mic not initialized");
      return;
    }

    try {
      // Don't add message here - let transcript.item from Telnyx handle it
      // This prevents duplicate messages

      // Generate TTS audio with selected voice
      const audioUrl = await generateTTS(text, ttsVoiceRef.current);

      // Start local playback immediately (in parallel with injection)
      // This ensures we hear our response at the same time it's being sent
      let localPlaybackPromise = Promise.resolve();
      if (localAudioEnabledRef.current) {
        const localAudio = new Audio(audioUrl);
        localAudio.volume = 0.7;
        localPlaybackPromise = localAudio.play().catch((e) => console.warn("[Voice] Local playback error:", e));
      }

      // Inject into mock microphone stream (runs in parallel with local playback)
      await mockMicRef.current.injectAudioFromUrl(audioUrl);

      // Wait for local playback to start (usually instant)
      await localPlaybackPromise;

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

  // Toggle mute (MANUAL mode) - mute/unmute real microphone
  const toggleMute = useCallback(() => {
    const call = activeCallRef.current;
    if (!call) {
      console.warn("[Voice] No active call for mute toggle");
      return;
    }
    
    const newMutedState = !isMuted;
    setIsMuted(newMutedState);
    
    // Get the active call's local stream and toggle audio tracks
    try {
      if (call.localStream) {
        const audioTracks = call.localStream.getAudioTracks();
        audioTracks.forEach((track) => {
          track.enabled = !newMutedState;
        });
        console.log(`[Voice] Microphone ${newMutedState ? 'muted' : 'unmuted'} (${audioTracks.length} tracks)`);
      } else {
        console.warn("[Voice] No local stream available for mute toggle");
      }
    } catch (err) {
      console.error("[Voice] Failed to toggle mute:", err);
    }
  }, [isMuted]);

  // Send manual message - uses REST API for chat, TTS+inject for voice
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
    } else if (channel === "voice" && voiceClientRef.current) {
      // Voice mode - convert text to TTS and inject into WebRTC
      // This is the same as auto mode but with user-typed text
      setSendingMessage(true);
      try {
        await speakTextViaAudio(messageText);
      } finally {
        setSendingMessage(false);
      }
    }
  }, [inputMessage, sendingMessage, channel, conversationId, sendChatMessage, isAutoMode, processAIResponse, currentStep, speakTextViaAudio]);

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
    setIsGeneratingResponse(false);
    setConversationId(null);
    setMessages([]);
    setMessageAnalysis({});
    setCurrentStep(0);
    currentStepRef.current = 0;
    lastAnalyzedMessageIndexRef.current = -1;
    workflowAnalysisInProgressRef.current = false;
    setWorkflowItemStatuses({});
    setWorkflowSlotsFilled({});
    setCustomerData(null); // Reset customer data for new test session
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
  }, []);

  // Handle auto-response when AI finishes speaking
  const handleVoiceAutoResponse = useCallback(async () => {
    if (!autoModeRef.current || respondingInProgressRef.current) return;
    if (!isTestRunningRef.current) return;

    respondingInProgressRef.current = true;
    
    try {
      // Wait for configured delay to allow AI to send multiple transcript messages
      // This prevents us from responding too quickly and interrupting the AI
      console.log(`[Voice] Waiting ${voiceResponseDelay}ms before generating response...`);
      await new Promise(r => setTimeout(r, voiceResponseDelay));
      
      if (!isTestRunningRef.current) {
        respondingInProgressRef.current = false;
        return;
      }

      // Get the last AI message from transcript (after delay, we have all messages)
      const lastAiMessage = messagesRef.current
        .filter(m => m.role === "assistant")
        .pop()?.content;

      if (!lastAiMessage) {
        console.log("[Voice] No AI message to respond to");
        respondingInProgressRef.current = false;
        return;
      }

      // Check for conversation ending phrases
      const ENDING_PHRASES = [
        "goodbye", "good bye", "bye", "have a great day", "have a nice day",
        "take care", "thank you for calling", "thanks for calling",
      ];
      const isEnding = ENDING_PHRASES.some(phrase => 
        lastAiMessage.toLowerCase().includes(phrase)
      );

      if (isEnding) {
        console.log("[Voice] Detected conversation ending, completing test");
        setMessages((prev) => [
          ...prev,
          {
            id: "system-complete",
            role: "system",
            content: "✅ Test completed - conversation ended naturally",
            timestamp: new Date().toISOString(),
          },
        ]);
        respondingInProgressRef.current = false;
        return;
      }

      // Generate dynamic response based on AI message
      console.log("[Voice] Generating response for:", lastAiMessage.substring(0, 50) + "...");
      setIsGeneratingResponse(true);
      
      const conversationHistory = messagesRef.current
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role, content: m.content }));

      const responseText = await generateDynamicResponse(lastAiMessage, conversationHistory);
      setIsGeneratingResponse(false);

      if (!responseText) {
        console.error("[Voice] Failed to generate response");
        respondingInProgressRef.current = false;
        return;
      }

      console.log(`[Voice] Responding: "${responseText.substring(0, 50)}..."`);
      setCurrentStep((prev) => prev + 1);
      currentStepRef.current += 1;
      
      // Speak the response (this waits for audio injection to complete)
      await speakTextViaAudio(responseText);
      
      // Wait for audio to be processed by AI
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      respondingInProgressRef.current = false;
    }
  }, [speakTextViaAudio, generateDynamicResponse, voiceResponseDelay]);

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
    setCustomerData(null); // Reset customer data for new voice test session
    setIsGeneratingResponse(false);
    setIsMuted(false); // Reset mute state
    
    setMessages([
      {
        id: "system-voice-start",
        role: "system",
        content: `Starting voice test: ${selectedPersona} persona (${isAutoMode ? 'AUTO - TTS injection' : 'MANUAL - real microphone'})`,
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      // Dynamic import of TelnyxAIAgent
      const { TelnyxAIAgent } = await import("@telnyx/ai-agent-lib");

      const client = new TelnyxAIAgent({
        agentId: agentId,
        debug: true,
      });

      // AUTO MODE: Initialize mock microphone for TTS injection
      // MANUAL MODE: Use real microphone directly (library handles it)
      if (isAutoMode) {
        console.log("[Voice] AUTO mode - initializing mock microphone for TTS injection...");
        const mockMic = new MockMicrophone();
        await mockMic.init();
        mockMicRef.current = mockMic;

        // Override getUserMedia to return mock stream for WebRTC
        const libGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (constraints.audio) {
            console.log("[Voice] getUserMedia intercepted - returning mock stream");
            console.log(`[Voice] Mock stream status: ${mockMic.debugStreamStatus()}`);
            return mockMic.getStream();
          }
          return libGetUserMedia(constraints);
        };
      } else {
        console.log("[Voice] MANUAL mode - requesting microphone permissions...");
        mockMicRef.current = null;
        
        // Request microphone permissions BEFORE connecting (like demo-portal)
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: true, 
            video: false 
          });
          // Stop the stream - we just needed permission
          stream.getTracks().forEach((track) => track.stop());
          console.log("[Voice] MANUAL mode - microphone permissions granted");
        } catch (audioError) {
          console.error("[Voice] Microphone permission denied:", audioError);
          notify({
            title: "Microphone Required",
            description: "Please allow microphone access for voice testing",
            variant: "error",
          });
          setVoiceStatus("error");
          setIsTestRunning(false);
          return;
        }
      }

      voiceClientRef.current = client;
      let lastAgentState = null;

      // Set up event handlers
      const currentAutoMode = isAutoMode; // Capture for closure
      client.on("agent.connected", () => {
        setVoiceStatus("active");
        setMessages((prev) => [
          ...prev,
          {
            id: "system-connected",
            role: "system",
            content: currentAutoMode 
              ? "✅ Connected to AI Agent (AUTO mode - TTS injection)"
              : "✅ Connected to AI Agent (MANUAL mode - real microphone)",
            timestamp: new Date().toISOString(),
          },
        ]);
      });

      client.on("agent.disconnected", () => {
        setVoiceStatus("idle");
        setIsTestRunning(false);
        setIsMuted(false);
        activeCallRef.current = null;
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
        console.log("[Voice] conversation.update:", conv?.call?.state, conv);
        
        if (conv?.call?.state === "active") {
          console.log("[Voice] Call is active");
          
          // Store call reference for mute/unmute
          activeCallRef.current = conv.call;
          
          // Connect remote audio stream so we can hear AI
          if (conv.call.remoteStream && remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = conv.call.remoteStream;
            console.log("[Voice] Remote audio stream connected");
          }
          
          // Log local stream info for debugging
          if (conv.call.localStream) {
            const tracks = conv.call.localStream.getAudioTracks();
            console.log(`[Voice] Local stream has ${tracks.length} audio tracks:`);
            tracks.forEach((track, i) => {
              console.log(`[Voice]   Track ${i}: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
            });
          } else {
            console.warn("[Voice] NO LOCAL STREAM - microphone not connected!");
          }
        } else {
          activeCallRef.current = null;
        }
      });

      await client.connect();
      await new Promise((r) => setTimeout(r, 1000));

      // Start conversation - pass mock stream in AUTO mode, let library use real mic in MANUAL mode
      const conversationOptions = {
        callerName: "Voice Test Harness",
      };
      
      if (isAutoMode && mockMicRef.current) {
        const mockStream = mockMicRef.current.getStream();
        console.log(`[Voice] AUTO mode - passing mock localStream: ${mockMicRef.current.debugStreamStatus()}`);
        conversationOptions.localStream = mockStream;
        conversationOptions.audio = true;
      } else {
        console.log("[Voice] MANUAL mode - library will request real microphone");
        // Explicitly request audio - library will call getUserMedia
        conversationOptions.audio = true;
      }
      
      await client.startConversation(conversationOptions);

      console.log(`[Voice] Conversation started (${isAutoMode ? 'AUTO' : 'MANUAL'} mode) - waiting for AI greeting...`);
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
  }, [agentId, selectedPersona, handleVoiceAutoResponse, isAutoMode]);

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

                {/* Customer Persona */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Customer Persona</label>
                  <Select
                    value={selectedPersona}
                    onValueChange={setSelectedPersona}
                    disabled={isTestRunning}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cooperative">Cooperative Customer</SelectItem>
                      <SelectItem value="frustrated">Frustrated Customer</SelectItem>
                      <SelectItem value="confused">Confused Customer</SelectItem>
                      <SelectItem value="wants_transfer">Wants Human Agent</SelectItem>
                      <SelectItem value="verbose">Verbose Customer</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {PERSONA_DESCRIPTIONS[selectedPersona]}
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

                {/* TTS Configuration (Voice channel + AUTO mode only) */}
                {channel === "voice" && isAutoMode && (
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

                    {/* Response Delay */}
                    <div className="pt-2">
                      <label className="text-sm font-medium">Response Delay</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Wait time before generating response ({voiceResponseDelay / 1000}s)
                      </p>
                      <input
                        type="range"
                        min="1000"
                        max="8000"
                        step="500"
                        value={voiceResponseDelay}
                        onChange={(e) => setVoiceResponseDelay(Number(e.target.value))}
                        disabled={isTestRunning}
                        className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-purple-500"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground mt-1">
                        <span>1s</span>
                        <span>8s</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

            <div className="pt-2 border-t">
              <h3 className="text-sm font-semibold mb-2">Controls</h3>
              <Badge
                variant="outline"
                className={cn(
                  "mb-3 w-full justify-center py-1 text-sm font-medium",
                  isTestRunning
                    ? "border-green-500 text-green-600 dark:border-green-400 dark:text-green-400"
                    : "border-emerald-500 text-emerald-600 dark:border-emerald-400 dark:text-emerald-400"
                )}
              >
                {isTestRunning ? "Test Running" : "Ready"}
              </Badge>
              <div className="space-y-3">
                {!isTestRunning ? (
                  <Button
                    className="w-full"
                    onClick={channel === "chat" ? startChatTest : startVoiceTest}
                    disabled={!agentId}
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
                <Badge
                  variant="outline"
                  className={cn(
                    "w-full justify-center gap-1.5",
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
                  {voiceStatus === "connecting" ? "Connecting..." : 
                   voiceStatus === "error" ? "Error" :
                   agentState.charAt(0).toUpperCase() + agentState.slice(1)}
                </Badge>
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
                    {isGeneratingResponse && (
                      <div className="flex items-center gap-2 text-purple-400 justify-end">
                        <span className="text-sm">Customer is thinking...</span>
                        <IconLoader2 className="size-4 animate-spin" />
                      </div>
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

                {/* Input Area (Chat and Voice) */}
                {isTestRunning && (
                  <div className="shrink-0 border-t p-4">
                    <div className="flex gap-2">
                      <Input
                        value={inputMessage}
                        onChange={(e) => setInputMessage(e.target.value)}
                        placeholder={channel === "voice" ? "Type to speak via TTS..." : "Type a message..."}
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
                          title={isMuted ? "Unmute microphone" : "Mute microphone"}
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
                          ? "Type text → converted to speech via TTS → sent to AI"
                          : (isMuted 
                              ? "🔇 Microphone muted - click to unmute"
                              : "🎤 Microphone active - speak naturally or click to mute")
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
  );
}
