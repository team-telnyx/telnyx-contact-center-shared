"use client";

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
import { useTelnyx } from "@/components/telephony-provider";
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
  IconHeadphones,
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
    
    // Try to disable AGC/noise suppression on the track
    const track = this.stream.getAudioTracks()[0];
    try {
      await track.applyConstraints({
        autoGainControl: false,
        noiseSuppression: false,
        echoCancellation: false,
      });
      console.log(`[MockMic] Disabled AGC/noise suppression on track`);
    } catch (e) {
      console.warn(`[MockMic] Could not disable AGC:`, e.message);
    }
    
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

    return new Promise((resolve, reject) => {
      try {
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        
        source.connect(this.destination);

        source.onended = () => {
          this.isPlaying = false;
          console.log(`[MockMic] Audio injection completed`);
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

  const response = await fetch("/api/tts/speech", {
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

// ============================================
// SERVER-SIDE VOICE CALL-FLOW TEST CONSTANTS
// ============================================

// Persona ids for the simulated caller (server-side call generator)
const VOICE_PERSONAS = [
  "neutral", "angry", "excited", "content", "sad", "scared", "happy",
  "enthusiastic", "curious", "calm", "grateful", "affectionate", "sarcastic",
  "surprised", "confident", "hesitant", "apologetic", "determined",
  "frustrated", "disappointed",
];

// Map flow eligibility reason codes to human-readable hints
const FLOW_REASON_LABELS = {
  missing_ai_assistant_start: "no AI assistant node",
  missing_agent_assist: "no Agent Assist (workflows) node",
  missing_transcription: "transcription not enabled",
  assistant_mismatch: "different assistant",
};

// Map server error codes to friendly messages
const VOICE_START_ERROR_LABELS = {
  flow_invalid: "Selected call flow is not valid for AI testing",
  call_generator_disabled: "Enable the Call Generator master switch in Settings first",
  workflow_has_no_assistant: "This workflow has no AI assistant assigned",
};

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

  // Server-side voice call-flow test state
  const [selectedCallFlowId, setSelectedCallFlowId] = useState("");
  const [eligibleFlows, setEligibleFlows] = useState([]);
  const [loadingFlows, setLoadingFlows] = useState(false);
  const [fromNumber, setFromNumber] = useState("");
  const [voicePersona, setVoicePersona] = useState("neutral");
  const [expressive, setExpressive] = useState(false);
  const [voiceReplyDelayMs, setVoiceReplyDelayMs] = useState(0);
  const [activeRunId, setActiveRunId] = useState(null);
  const [activeLedgerId, setActiveLedgerId] = useState(null);
  const [voiceTestStatus, setVoiceTestStatus] = useState("idle"); // dialing|ringing|answered|talking|completed|failed|abandoned
  const [voiceTranscript, setVoiceTranscript] = useState([]); // [{ role:'agent'|'caller', text, at }]
  // Silent WebRTC listener (Telnyx monitor supervision) so the user can HEAR the live AI<->caller call
  const { client: telnyxClient, status: telnyxStatus } = useTelnyx();
  const [listenerEnabled, setListenerEnabled] = useState(true); // user preference: auto-attach listener
  const [listenerStatus, setListenerStatus] = useState("off"); // off|connecting|ringing|listening|error
  const [supervisorCallControlId, setSupervisorCallControlId] = useState(null);
  
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
  const voicePollTimerRef = useRef(null); // Polling interval for server-side voice test
  const activeRunIdRef = useRef(null);
  const activeLedgerIdRef = useRef(null);
  activeRunIdRef.current = activeRunId;
  activeLedgerIdRef.current = activeLedgerId;
  // Listener refs
  const listenerAudioRef = useRef(null); // hidden <audio> for the monitor leg
  const supervisorCallControlIdRef = useRef(null);
  const supervisorWebrtcCallRef = useRef(null); // the WebRTC call object we auto-answer
  const listenerRequestedRef = useRef(false); // guard: only request one listener per test
  const listenerEnabledRef = useRef(true);
  supervisorCallControlIdRef.current = supervisorCallControlId;
  listenerEnabledRef.current = listenerEnabled;

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

  // Fetch eligible call flows for server-side voice test (on mount if voice, and when switching to voice)
  useEffect(() => {
    if (channel !== "voice") return;
    let cancelled = false;
    async function loadFlows() {
      setLoadingFlows(true);
      try {
        const res = await fetch(`/api/admin/workflows/${flowId}/voice-test/flows`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Failed to load call flows");
        }
        const flows = Array.isArray(data.flows) ? data.flows : [];
        setEligibleFlows(flows);
        // Auto-select first eligible flow if none selected
        setSelectedCallFlowId((prev) => {
          if (prev && flows.some((f) => f.id === prev && f.eligible)) return prev;
          const firstEligible = flows.find((f) => f.eligible);
          return firstEligible ? firstEligible.id : "";
        });
      } catch (err) {
        if (!cancelled) {
          console.error("[Voice] Failed to load call flows:", err);
          setEligibleFlows([]);
        }
      } finally {
        if (!cancelled) setLoadingFlows(false);
      }
    }
    loadFlows();
    return () => {
      cancelled = true;
    };
  }, [channel, flowId]);

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

  // ============================================
  // SERVER-SIDE VOICE CALL-FLOW TEST
  // ============================================

  // Stop the live transcript polling loop
  const stopVoicePolling = useCallback(() => {
    if (voicePollTimerRef.current) {
      clearInterval(voicePollTimerRef.current);
      voicePollTimerRef.current = null;
    }
  }, []);

  // --- Silent WebRTC listener (Telnyx monitor) ------------------------------
  // Attach the monitor leg's remote audio to the hidden <audio> element so the
  // user hears the live AI<->caller conversation. Listen-only: the mic is never
  // sent into the call (monitor role on the Telnyx side).
  const attachListenerAudio = useCallback((webrtcCall) => {
    const audioEl = listenerAudioRef.current;
    if (!webrtcCall || !audioEl) return;
    try {
      if (typeof webrtcCall.setAudioElement === "function") webrtcCall.setAudioElement(audioEl);
      if (typeof webrtcCall.attachAudio === "function") webrtcCall.attachAudio(audioEl);
      const remoteStream =
        webrtcCall.remoteStream || webrtcCall.remoteMediaStream || webrtcCall.stream;
      if (remoteStream && audioEl.srcObject !== remoteStream) audioEl.srcObject = remoteStream;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = false;
      const playResult = audioEl.play?.();
      if (playResult?.catch) {
        playResult.catch((e) => console.warn("[Voice listener] autoplay blocked:", e?.message || e));
      }
    } catch (e) {
      console.error("[Voice listener] attach audio failed:", e);
    }
  }, []);

  // Tear down the listener leg (server hangup + local cleanup).
  const stopListener = useCallback(async () => {
    listenerRequestedRef.current = false;
    const supId = supervisorCallControlIdRef.current;
    const webrtcCall = supervisorWebrtcCallRef.current;
    supervisorWebrtcCallRef.current = null;
    try {
      if (webrtcCall?.hangup) webrtcCall.hangup();
    } catch (_) {}
    if (listenerAudioRef.current) {
      try { listenerAudioRef.current.srcObject = null; } catch (_) {}
    }
    setSupervisorCallControlId(null);
    supervisorCallControlIdRef.current = null;
    setListenerStatus("off");
    if (supId) {
      try {
        await fetch(`/api/admin/workflows/${flowId}/voice-test/listen`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ supervisorCallControlId: supId }),
        });
      } catch (err) {
        console.error("[Voice listener] stop failed:", err);
      }
    }
  }, [flowId]);

  // Request a monitor leg for the running test. The browser receives it as an
  // inbound WebRTC call and auto-answers it (see the notification effect below).
  const startListener = useCallback(async () => {
    if (listenerRequestedRef.current) return;
    if (!listenerEnabledRef.current) return;
    const runId = activeRunIdRef.current;
    const ledgerId = activeLedgerIdRef.current;
    if (!runId || !ledgerId) return;
    if (telnyxStatus !== "connected" || !telnyxClient) {
      setListenerStatus("error");
      notify({
        title: "Audio listener unavailable",
        description: "Your softphone (WebRTC) is not connected, so live audio can't be attached. The transcript still updates live.",
        variant: "warning",
      });
      return;
    }
    listenerRequestedRef.current = true;
    setListenerStatus("connecting");
    try {
      const res = await fetch(`/api/admin/workflows/${flowId}/voice-test/listen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, ledgerId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        listenerRequestedRef.current = false;
        setListenerStatus("error");
        notify({
          title: "Couldn't attach audio listener",
          description: typeof data?.error === "string" ? data.error : "Failed to start the listener.",
          variant: "error",
        });
        return;
      }
      setSupervisorCallControlId(data.supervisorCallControlId);
      supervisorCallControlIdRef.current = data.supervisorCallControlId;
      setListenerStatus("ringing");
    } catch (err) {
      listenerRequestedRef.current = false;
      setListenerStatus("error");
      console.error("[Voice listener] start failed:", err);
    }
  }, [flowId, telnyxClient, telnyxStatus]);

  // Auto-answer the inbound monitor (supervisor) WebRTC call when it arrives.
  useEffect(() => {
    if (!telnyxClient) return;
    const onNotification = (notification) => {
      try {
        const call = notification?.call;
        if (!call) return;
        // Only act while we are waiting for a listener leg for this test.
        if (!listenerRequestedRef.current || supervisorWebrtcCallRef.current) return;
        const state = String(call.state || "").toLowerCase();
        const direction = String(call.direction || "").toLowerCase();
        const isInbound = direction === "inbound" || direction === "incoming" || state === "new" || state === "ringing";
        const isRinging = state === "new" || state === "ringing" || state === "early";
        if (isInbound && isRinging) {
          supervisorWebrtcCallRef.current = call;
          // Answer the monitor call; we only listen.
          Promise.resolve(call.answer?.())
            .then(() => {
              setListenerStatus("listening");
              [0, 150, 400, 800].forEach((d) =>
                setTimeout(() => attachListenerAudio(supervisorWebrtcCallRef.current || call), d),
              );
            })
            .catch((e) => {
              console.error("[Voice listener] answer failed:", e);
              setListenerStatus("error");
              supervisorWebrtcCallRef.current = null;
            });
        } else if (["hangup", "destroy", "ended", "purge"].includes(state)) {
          if (supervisorWebrtcCallRef.current === call) {
            supervisorWebrtcCallRef.current = null;
            setListenerStatus((prev) => (prev === "listening" ? "off" : prev));
          }
        }
      } catch (e) {
        console.error("[Voice listener] notification handler error:", e);
      }
    };
    try { telnyxClient.on?.("telnyx.notification", onNotification); } catch (_) {}
    return () => {
      try { telnyxClient.off?.("telnyx.notification", onNotification); } catch (_) {}
    };
  }, [telnyxClient, attachListenerAudio]);

  // Poll the server for the current voice-test session state and render the live transcript
  const pollVoiceSession = useCallback(async () => {
    const runId = activeRunIdRef.current;
    const ledgerId = activeLedgerIdRef.current;
    if (!runId || !ledgerId) return;
    try {
      const qs = new URLSearchParams({ runId, ledgerId }).toString();
      const res = await fetch(`/api/admin/workflows/${flowId}/voice-test/session?${qs}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        console.error("[Voice] Session poll failed:", data?.error);
        return;
      }

      if (data.status) setVoiceTestStatus(data.status);
      if (Array.isArray(data.history)) {
        setVoiceTranscript(
          data.history.map((h) => ({ role: h.role, text: h.text, at: h.at }))
        );
      }

      // Once the AI assistant call is up, auto-attach the silent audio listener
      // so the user can hear the live AI<->caller conversation.
      if (
        ["answered", "talking"].includes(data.status) &&
        listenerEnabledRef.current &&
        !listenerRequestedRef.current
      ) {
        startListener();
      }

      // Stop polling on a terminal status
      if (["completed", "failed", "abandoned"].includes(data.status)) {
        stopVoicePolling();
        stopListener();
        isTestRunningRef.current = false;
        setIsTestRunning(false);
        if (data.status === "failed" && data.error) {
          notify({
            title: "Voice test failed",
            description: typeof data.error === "string" ? data.error : "The voice test failed.",
            variant: "error",
          });
        }
      }
    } catch (err) {
      console.error("[Voice] Session poll error:", err);
    }
  }, [flowId, stopVoicePolling, startListener, stopListener]);

  // Stop the server-side voice test (hang up + stop polling)
  const stopVoiceTest = useCallback(async () => {
    const runId = activeRunIdRef.current;
    const ledgerId = activeLedgerIdRef.current;
    stopVoicePolling();
    stopListener();
    isTestRunningRef.current = false;
    setIsTestRunning(false);
    if (runId && ledgerId) {
      try {
        await fetch(`/api/admin/workflows/${flowId}/voice-test/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop", runId, ledgerId }),
        });
      } catch (err) {
        console.error("[Voice] Failed to stop voice test:", err);
      }
    }
    setVoiceTestStatus((prev) =>
      ["completed", "failed", "abandoned"].includes(prev) ? prev : "completed"
    );
  }, [flowId, stopVoicePolling, stopListener]);

  // Start the server-side voice call-flow test
  const startVoiceTest = useCallback(async () => {
    if (!selectedCallFlowId) {
      notify({
        title: "Select a call flow",
        description: "Choose an eligible call flow to test.",
        variant: "error",
      });
      return;
    }
    if (!fromNumber.trim()) {
      notify({
        title: "From number required",
        description: "Enter an E.164 phone number (e.g. +15551234567).",
        variant: "error",
      });
      return;
    }

    setVoiceTranscript([]);
    setVoiceTestStatus("dialing");
    setIsTestRunning(true);
    isTestRunningRef.current = true;
    // Reset listener state for a fresh test
    listenerRequestedRef.current = false;
    supervisorWebrtcCallRef.current = null;
    setSupervisorCallControlId(null);
    setListenerStatus(listenerEnabledRef.current ? "off" : "off");
    try {
      const res = await fetch(`/api/admin/workflows/${flowId}/voice-test/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowId: selectedCallFlowId,
          fromNumber: fromNumber.trim(),
          persona: voicePersona,
          voice: ttsVoiceId || ttsVoice,
          expressive,
          replyDelayMs: voiceReplyDelayMs,
          maxDurationSecs: 300,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        const code = data?.error;
        const friendly =
          (code && VOICE_START_ERROR_LABELS[code]) ||
          (typeof code === "string" ? code : "Failed to start voice test");
        notify({
          title: "Failed to start voice test",
          description: data?.details ? `${friendly} (${data.details})` : friendly,
          variant: "error",
        });
        setVoiceTestStatus("failed");
        setIsTestRunning(false);
        isTestRunningRef.current = false;
        return;
      }

      setActiveRunId(data.runId);
      setActiveLedgerId(data.ledgerId);
      activeRunIdRef.current = data.runId;
      activeLedgerIdRef.current = data.ledgerId;
      setVoiceTestStatus("ringing");

      // Begin polling the session state
      stopVoicePolling();
      voicePollTimerRef.current = setInterval(() => {
        pollVoiceSession();
      }, 1500);
      // Kick off an immediate poll
      pollVoiceSession();
    } catch (err) {
      console.error("[Voice] Failed to start voice test:", err);
      notify({
        title: "Failed to start voice test",
        description: err.message || "An unknown error occurred",
        variant: "error",
      });
      setVoiceTestStatus("failed");
      setIsTestRunning(false);
      isTestRunningRef.current = false;
    }
  }, [
    flowId,
    selectedCallFlowId,
    fromNumber,
    voicePersona,
    ttsVoiceId,
    ttsVoice,
    expressive,
    voiceReplyDelayMs,
    pollVoiceSession,
    stopVoicePolling,
  ]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (voicePollTimerRef.current) {
        clearInterval(voicePollTimerRef.current);
        voicePollTimerRef.current = null;
      }
      // Best-effort: hang up the listener leg if one is active when leaving.
      const supId = supervisorCallControlIdRef.current;
      try {
        if (supervisorWebrtcCallRef.current?.hangup) supervisorWebrtcCallRef.current.hangup();
      } catch (_) {}
      if (supId) {
        try {
          fetch(`/api/admin/workflows/${flowId}/voice-test/listen`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ supervisorCallControlId: supId }),
            keepalive: true,
          });
        } catch (_) {}
      }
    };
  }, [flowId]);

  if (loading) {
    return (
      <AdminPageShell>
        <AdminPageHeader title="Test AI Agent" badges={<Badge variant="secondary">Loading</Badge>} />
        <AdminPageContent>
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
        </AdminPageContent>
      </AdminPageShell>
    );
  }

  return (
    <AdminPageShell>
      <AdminPageHeader title="Test AI Agent" badges={<Badge variant="secondary">{workflow?.name || "Workflow"}</Badge>} />
      <AdminPageContent>
        <div className="space-y-4">
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

                {/* Voice channel: server-side call-flow test configuration */}
                {channel === "voice" && (
                  <div className="space-y-3 pt-3 border-t">
                    {/* Test call flow */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Test call flow</label>
                      <Select
                        value={selectedCallFlowId}
                        onValueChange={setSelectedCallFlowId}
                        disabled={isTestRunning || loadingFlows}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue placeholder={loadingFlows ? "Loading…" : "Select a call flow"} />
                        </SelectTrigger>
                        <SelectContent>
                          {eligibleFlows.map((flow) => {
                            const reasonLabel = (flow.reasons || [])
                              .map((r) => FLOW_REASON_LABELS[r] || r)
                              .filter(Boolean)
                              .join(", ");
                            return (
                              <SelectItem
                                key={flow.id}
                                value={flow.id}
                                disabled={!flow.eligible}
                              >
                                {flow.name}
                                {!flow.eligible && reasonLabel ? ` — ${reasonLabel}` : ""}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      {!loadingFlows && !eligibleFlows.some((f) => f.eligible) && (
                        <p className="text-xs text-muted-foreground">
                          Create a call flow with Answer (transcription on) → Agent Assist (Workflows) → Start AI Assistant
                        </p>
                      )}
                    </div>

                    {/* From number */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium">From number</label>
                      <Input
                        value={fromNumber}
                        onChange={(e) => setFromNumber(e.target.value)}
                        placeholder="+15551234567"
                        disabled={isTestRunning}
                        className="h-8"
                      />
                      <p className="text-xs text-muted-foreground">
                        E.164 format (e.g. +15551234567)
                      </p>
                    </div>

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

                    {/* Caller persona */}
                    <div className="space-y-2 pt-2">
                      <label className="text-sm font-medium">Caller persona</label>
                      <Select
                        value={voicePersona}
                        onValueChange={setVoicePersona}
                        disabled={isTestRunning}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue placeholder="Persona" />
                        </SelectTrigger>
                        <SelectContent>
                          {VOICE_PERSONAS.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p.charAt(0).toUpperCase() + p.slice(1)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Expressive mode */}
                    <div className="flex items-center justify-between pt-2">
                      <Label htmlFor="expressive-mode" className="text-sm font-medium cursor-pointer">
                        Expressive mode
                      </Label>
                      <Switch
                        id="expressive-mode"
                        checked={expressive}
                        onCheckedChange={setExpressive}
                        disabled={isTestRunning}
                      />
                    </div>

                    {/* Reply delay */}
                    <div className="pt-2">
                      <label className="text-sm font-medium">Reply delay</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Pause before the simulated caller answers ({(voiceReplyDelayMs / 1000).toFixed(1)}s)
                      </p>
                      <input
                        type="range"
                        min="0"
                        max="10000"
                        step="500"
                        value={voiceReplyDelayMs}
                        onChange={(e) => setVoiceReplyDelayMs(Number(e.target.value))}
                        disabled={isTestRunning}
                        className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-purple-500"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground mt-1">
                        <span>0s</span>
                        <span>10s</span>
                      </div>
                    </div>

                    {/* Live audio listener */}
                    <div className="flex items-center justify-between pt-2">
                      <div className="space-y-0.5">
                        <Label htmlFor="listener-enabled" className="text-sm font-medium cursor-pointer">
                          Listen to live audio
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Hear the AI↔caller call via your softphone (listen-only)
                        </p>
                      </div>
                      <Switch
                        id="listener-enabled"
                        checked={listenerEnabled}
                        onCheckedChange={(checked) => {
                          setListenerEnabled(checked);
                          listenerEnabledRef.current = checked;
                          if (!checked) stopListener();
                          else if (["answered", "talking"].includes(voiceTestStatus)) startListener();
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

            <div className="pt-2 border-t">
              <h3 className="text-sm font-semibold mb-2">Controls</h3>
              {/* Status Badge - shows Voice Status when voice test active, otherwise Ready/Test Running */}
              {isTestRunning && channel === "voice" ? (
                <Badge
                  variant="outline"
                  className={cn(
                    "mb-3 w-full justify-center gap-1.5",
                    voiceTestStatus === "answered" && "text-blue-500 border-blue-500",
                    voiceTestStatus === "talking" && "text-green-500 border-green-500",
                    (voiceTestStatus === "dialing" || voiceTestStatus === "ringing") && "text-yellow-500 border-yellow-500",
                    voiceTestStatus === "completed" && "text-emerald-500 border-emerald-500",
                    (voiceTestStatus === "failed" || voiceTestStatus === "abandoned") && "text-red-500 border-red-500"
                  )}
                >
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    voiceTestStatus === "answered" && "bg-blue-500",
                    voiceTestStatus === "talking" && "bg-green-500 animate-pulse",
                    (voiceTestStatus === "dialing" || voiceTestStatus === "ringing") && "bg-yellow-500 animate-pulse",
                    voiceTestStatus === "completed" && "bg-emerald-500",
                    (voiceTestStatus === "failed" || voiceTestStatus === "abandoned") && "bg-red-500"
                  )} />
                  {voiceTestStatus === "dialing" ? "Dialing" :
                   voiceTestStatus === "ringing" ? "Ringing" :
                   voiceTestStatus === "answered" ? "Answered" :
                   voiceTestStatus === "talking" ? "Talking" :
                   voiceTestStatus === "completed" ? "Completed" :
                   voiceTestStatus === "failed" ? "Failed" :
                   voiceTestStatus === "abandoned" ? "Abandoned" :
                   "Connecting..."}
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
                  {isTestRunning ? "Test Running" : "Ready"}
                </Badge>
              )}
              {/* Live audio listener status (voice channel only) */}
              {channel === "voice" && listenerEnabled && (
                <Badge
                  variant="outline"
                  className={cn(
                    "mb-3 w-full justify-center gap-1.5",
                    listenerStatus === "listening" && "text-green-500 border-green-500",
                    (listenerStatus === "connecting" || listenerStatus === "ringing") && "text-yellow-500 border-yellow-500",
                    listenerStatus === "error" && "text-red-500 border-red-500",
                    listenerStatus === "off" && "text-muted-foreground"
                  )}
                  title="Silent monitor: you hear the call but are not heard"
                >
                  <IconHeadphones className="size-3.5" />
                  {listenerStatus === "listening" ? "Listening to live call" :
                   listenerStatus === "ringing" ? "Connecting audio…" :
                   listenerStatus === "connecting" ? "Requesting audio…" :
                   listenerStatus === "error" ? "Audio unavailable" :
                   isTestRunning ? "Audio idle" : "Audio listener ready"}
                </Badge>
              )}
              {/* Hidden audio sink for the monitor leg */}
              <audio ref={listenerAudioRef} autoPlay playsInline className="hidden" />
              <div className="space-y-3">
                {!isTestRunning ? (
                  <Button
                    className="w-full"
                    onClick={channel === "chat" ? startChatTest : startVoiceTest}
                    disabled={
                      channel === "chat"
                        ? !agentId
                        : !selectedCallFlowId || !fromNumber.trim()
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
                      onClick={channel === "voice" ? stopVoiceTest : stopTest}
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
                    {channel === "voice" ? (
                      <>
                        {/* Live call status line */}
                        {(isTestRunning || voiceTranscript.length > 0) && (
                          <div className="text-center text-xs text-muted-foreground py-2">
                            {voiceTestStatus === "dialing" ? "Dialing…" :
                             voiceTestStatus === "ringing" ? "Ringing…" :
                             voiceTestStatus === "answered" ? "Answered" :
                             voiceTestStatus === "talking" ? "Talking" :
                             voiceTestStatus === "completed" ? "Completed" :
                             voiceTestStatus === "failed" ? "Failed" :
                             voiceTestStatus === "abandoned" ? "Abandoned" :
                             "Idle"}
                          </div>
                        )}
                        {voiceTranscript.length === 0 ? (
                          <div className="flex flex-col items-center justify-center h-full text-center py-12">
                            <IconPhone className="size-12 text-muted-foreground/50 mb-4" />
                            <p className="text-sm text-muted-foreground">
                              No transcript yet
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Click "Start Test" to place a test call
                            </p>
                          </div>
                        ) : (
                          voiceTranscript.map((turn, idx) => {
                            const isCaller = turn.role === "caller";
                            return (
                              <div
                                key={`voice-${idx}-${turn.at || ""}`}
                                className={cn(
                                  "flex",
                                  isCaller ? "justify-end" : "justify-start"
                                )}
                              >
                                <div
                                  className={cn(
                                    "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                                    isCaller
                                      ? "bg-primary text-primary-foreground"
                                      : "bg-muted text-foreground"
                                  )}
                                >
                                  <div className="text-[10px] uppercase tracking-wide opacity-70 mb-0.5">
                                    {isCaller ? "Caller" : "Agent"}
                                  </div>
                                  {turn.text}
                                </div>
                              </div>
                            );
                          })
                        )}
                        <div ref={messagesEndRef} />
                      </>
                    ) : (
                      <>
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
                      </>
                    )}
                    </div>
                  </ScrollArea>
                </div>

                {/* Input Area (Chat only — voice uses the server-side call-flow test) */}
                {isTestRunning && channel === "chat" && (
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
      </AdminPageContent>
    </AdminPageShell>
  );
}
