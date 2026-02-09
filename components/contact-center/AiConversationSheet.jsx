"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  IconRobot,
  IconCopy,
  IconCheck,
  IconMessageCircle,
} from "@tabler/icons-react";
import { Play, Pause } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import AiConversationMessagesTab from "./AiConversationMessagesTab";
import AiConversationInsightsTab from "./AiConversationInsightsTab";
import AiConversationMetadataTab from "./AiConversationMetadataTab";
import AiConversationDynamicVariablesTab from "./AiConversationDynamicVariablesTab";

const AI_HEADER_NAME = "x-ai-call-id";

function normalizeHeaderName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getAiCallIdFromEvents(events) {
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    const type = String(
      event?.event_type || event?.eventType || event?.type || "",
    ).toLowerCase();
    if (!type.includes("call.initiated")) continue;
    const payload = event?.payload?.payload || event?.payload || {};
    const customHeaders =
      payload?.custom_headers || payload?.customHeaders || [];
    if (!Array.isArray(customHeaders)) continue;
    const match = customHeaders.find(
      (header) => normalizeHeaderName(header?.name) === AI_HEADER_NAME,
    );
    if (match?.value) return match.value;
  }
  return null;
}

function CopyInline({ value }) {
  const [copied, setCopied] = useState(false);
  async function doCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {}
  }
  return (
    <Button
      size="icon"
      variant="ghost"
      className={copied ? "h-7 w-7 text-telnyx-green" : "h-7 w-7"}
      onClick={doCopy}
      title={copied ? "Copied" : "Copy"}
    >
      {copied ? (
        <IconCheck className="size-4 text-telnyx-green" />
      ) : (
        <IconCopy className="size-4" />
      )}
    </Button>
  );
}

/**
 * Helper function to fetch AI conversation by call_control_id with fallback to demo API key
 * @param {string} callControlId - The call_control_id to search for
 * @param {boolean} useDemoApiKey - Whether to use demo API key
 * @returns {Promise<{ok: boolean, conversation: any|null, status: number}>}
 */
async function fetchConversationByCallControlId(callControlId, useDemoApiKey = false) {
  const params = new URLSearchParams();
  params.set("metadata->call_control_id", `eq.${callControlId}`);
  params.set("limit", "1");
  params.set("order", "created_at.desc");
  if (useDemoApiKey) {
    params.set("useDemoApiKey", "true");
  }
  
  try {
    const res = await fetch(`/api/ai/conversations?${params.toString()}`, {
      cache: "no-store",
    });
    const data = await res.json();
    
    if (res.ok && data?.ok) {
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length > 0) {
        return { ok: true, conversation: items[0], status: res.status };
      }
    }
    
    return { ok: false, conversation: null, status: res.status };
  } catch (err) {
    return { ok: false, conversation: null, status: 0 };
  }
}

export default function AiConversationSheet({
  interaction,
  triggerClassName,
  iconClassName,
  stopPropagation = false,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("conversation");
  const isOpen = openProp ?? internalOpen;
  const handleOpenChange = (nextOpen) => {
    if (onOpenChange) {
      onOpenChange(nextOpen);
    } else {
      setInternalOpen(nextOpen);
    }
  };

  // Initialize aiCallControlId immediately from interaction prop
  // Use ONLY ai_call_control_id (from X-AI-Call-ID header), not agent_call_control_id
  const initialAiCallControlId = useMemo(() => {
    return (
      interaction?.metadata?.ai_call_control_id ||
      interaction?.metadata?.ai_call_id ||
      interaction?.ai_call_control_id ||
      interaction?.aiCallControlId ||
      null
    );
  }, [
    interaction?.metadata?.ai_call_control_id,
    interaction?.metadata?.ai_call_id,
    interaction?.ai_call_control_id,
    interaction?.aiCallControlId,
  ]);

  // Check if we have a conversation_id directly (for scheduled events)
  const conversationId = useMemo(() => {
    return (
      interaction?.conversation_id ||
      interaction?.metadata?.conversation_id ||
      null
    );
  }, [interaction?.conversation_id, interaction?.metadata?.conversation_id]);

  const [aiCallControlId, setAiCallControlId] = useState(
    initialAiCallControlId,
  );
  const [conversation, setConversation] = useState(null);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [usedDemoApiKey, setUsedDemoApiKey] = useState(false);
  const [messages, setMessages] = useState([]);
  const [recording, setRecording] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const waveformRef = useRef(null);
  const wavesurferRef = useRef(null);

  const isInbound = useMemo(() => {
    const direction = String(interaction?.direction || "").toLowerCase();
    return direction === "incoming" || direction === "inbound";
  }, [interaction?.direction]);

  // Check if this call came from X-AI-Call-ID header (has ai_call_control_id)
  const hasAiCallControlId = useMemo(() => {
    return !!(
      interaction?.metadata?.ai_call_control_id ||
      interaction?.ai_call_control_id ||
      aiCallControlId
    );
  }, [
    interaction?.metadata?.ai_call_control_id,
    interaction?.ai_call_control_id,
    aiCallControlId,
  ]);

  // Update aiCallControlId when interaction changes
  useEffect(() => {
    setAiCallControlId(initialAiCallControlId);
  }, [initialAiCallControlId]);

  useEffect(() => {
    // If we already have it from metadata, don't fetch
    if (initialAiCallControlId) {
      return;
    }
    if (!interaction?.call_session_id || !isInbound) {
      setAiCallControlId(null);
      return;
    }
    let cancelled = false;
    async function loadCallHeader() {
      try {
        const params = new URLSearchParams();
        params.set("page[number]", "1");
        params.set("page[size]", "100");
        params.set(
          "filter[application_session_id]",
          interaction.call_session_id,
        );

        const res = await fetch(
          `/api/voice/call-history/events?${params.toString()}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!cancelled && data?.ok) {
          const events = Array.isArray(data?.data) ? data.data : [];
          const aiId = getAiCallIdFromEvents(events);
          setAiCallControlId(aiId || null);
        } else if (!cancelled) {
          setAiCallControlId(null);
        }
      } catch {
        if (!cancelled) setAiCallControlId(null);
      }
    }
    loadCallHeader();
    return () => {
      cancelled = true;
    };
  }, [interaction?.call_session_id, initialAiCallControlId, isInbound]);

  useEffect(() => {
    if (!isOpen) return;

    // Use agent_call_control_id (from X-AI-Call-ID header) for conversation lookup
    const agentCallControlId =
      interaction?.metadata?.agent_call_control_id || aiCallControlId;

    if (!agentCallControlId && !conversationId) return;

    // Reset demo API key flag when starting a new fetch
    setUsedDemoApiKey(false);

    let cancelled = false;
    async function loadConversation() {
      setLoadingConversation(true);
      try {
        let res;
        let conversationFound = false;

        // If we have conversation_id, load directly by ID
        if (conversationId) {
          res = await fetch(
            `/api/ai/conversations/${encodeURIComponent(conversationId)}`,
            {
              cache: "no-store",
            },
          );
          if (!cancelled && res.ok) {
            const data = await res.json();
            // Handle API response format: { ok: true, data: {...} }
            const conversation = data?.data || data;
            if (conversation) {
              setConversation(conversation);
              conversationFound = true;
            }
          }
          
          // If not found and this is an AI call, try with demo API key
          if (!conversationFound && hasAiCallControlId && (!res.ok || res.status === 403 || res.status === 404)) {
            const demoRes = await fetch(
              `/api/ai/conversations/${encodeURIComponent(conversationId)}?useDemoApiKey=true`,
              {
                cache: "no-store",
              },
            );
            if (!cancelled && demoRes.ok) {
              const demoData = await demoRes.json();
              const demoConversation = demoData?.data || demoData;
              if (demoConversation) {
                setConversation(demoConversation);
                setUsedDemoApiKey(true);
                conversationFound = true;
              }
            }
          }
          
          if (!cancelled && !conversationFound) {
            setConversation(null);
          }
        } else if (agentCallControlId) {
          // Load by filtering with call_control_id from metadata
          // Try agent_call_control_id first (matches the recording lookup)
          let result = await fetchConversationByCallControlId(agentCallControlId, false);
          let shouldTryDemo = !result.ok || result.status === 403 || result.status === 404;
          
          if (!cancelled && result.ok && result.conversation) {
            setConversation(result.conversation);
            conversationFound = true;
          } else {
            // Fallback: try with ai_call_control_id if different from agent_call_control_id
            const aiCallId = interaction?.metadata?.ai_call_control_id;
            if (aiCallId && aiCallId !== agentCallControlId) {
              result = await fetchConversationByCallControlId(aiCallId, false);
              if (!cancelled && result.ok && result.conversation) {
                setConversation(result.conversation);
                conversationFound = true;
              } else if (!result.ok || result.status === 403 || result.status === 404) {
                shouldTryDemo = true;
              }
            }
            
            // If still not found and this is an AI call, try with demo API key
            if (!conversationFound && hasAiCallControlId && shouldTryDemo) {
              // Try with agent_call_control_id on demo account
              result = await fetchConversationByCallControlId(agentCallControlId, true);
              if (!cancelled && result.ok && result.conversation) {
                setConversation(result.conversation);
                setUsedDemoApiKey(true);
                conversationFound = true;
              } else if (aiCallId && aiCallId !== agentCallControlId) {
                // Try with ai_call_control_id on demo account
                result = await fetchConversationByCallControlId(aiCallId, true);
                if (!cancelled && result.ok && result.conversation) {
                  setConversation(result.conversation);
                  setUsedDemoApiKey(true);
                  conversationFound = true;
                }
              }
            }
            
            if (!cancelled && !conversationFound) {
              setConversation(null);
            }
          }
        }
      } catch {
        if (!cancelled) setConversation(null);
      } finally {
        if (!cancelled) setLoadingConversation(false);
      }
    }
    loadConversation();
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    aiCallControlId,
    conversationId,
    interaction?.metadata?.agent_call_control_id,
    interaction?.metadata?.ai_call_control_id,
  ]);

  useEffect(() => {
    if (!isOpen) {
      setActiveTab("conversation");
      setMessages([]);
      setRecording(null);
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setUsedDemoApiKey(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const fetchRecording = async () => {
      // Fetch recording using ONLY ai_call_control_id from metadata
      // This corresponds to the call_control_id passed in X-AI-Call-ID header
      // Do NOT use agent_call_control_id - only use ai_call_control_id
      if (!aiCallControlId) {
        setRecording(null);
        return;
      }

      try {
        // Use the new call_control_id parameter - endpoint will fetch call_session_id internally
        const recordingsRes = await fetch(
          `/api/voice/recordings?call_control_id=${encodeURIComponent(
            aiCallControlId,
          )}`,
          { cache: "no-store" },
        );
        const recordingsData = await recordingsRes.json();

        if (
          recordingsData.ok &&
          recordingsData.data &&
          recordingsData.data.length > 0
        ) {
          // Found recording for the AI call control ID - use it
          setRecording(recordingsData.data[0]);
        } else {
          // No recording found for this call_control_id
          setRecording(null);
        }
      } catch (error) {
        console.error(
          "[AiConversationSheet] Error fetching recording by ai_call_control_id:",
          error,
        );
        setRecording(null);
      }
    };

    fetchRecording();
  }, [isOpen, aiCallControlId]);

  useEffect(() => {
    if (!recording || !waveformRef.current || !isOpen) return;

    const timer = setTimeout(async () => {
      const wavesurfer = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: "#6b7280",
        progressColor: "#22c55e",
        cursorColor: "#16a34a",
        barWidth: 2,
        barRadius: 3,
        responsive: true,
        height: 50,
        normalize: true,
        backend: "WebAudio",
        mediaControls: false,
      });

      wavesurferRef.current = wavesurfer;

      wavesurfer.on("ready", () => {
        setDuration(wavesurfer.getDuration());
      });

      wavesurfer.on("play", () => {
        setIsPlaying(true);
      });

      wavesurfer.on("pause", () => {
        setIsPlaying(false);
      });

      wavesurfer.on("finish", () => {
        setIsPlaying(false);
      });

      wavesurfer.on("timeupdate", (time) => {
        setCurrentTime(time);
      });

      wavesurfer.on("error", (error) => {
        console.error("WaveSurfer error:", error);
        toast.error("Failed to load recording");
      });

      try {
        // Always use proxy endpoint to avoid CORS issues
        let audioUrl = null;
        if (recording.id || recording.recording_id) {
          // Use recording ID proxy endpoint (preferred)
          const recordingId = recording.id || recording.recording_id;
          audioUrl = `/api/voice/recordings/${encodeURIComponent(
            recordingId,
          )}/stream`;
        } else if (recording.recording_url) {
          const url = recording.recording_url;
          if (url.startsWith("http://") || url.startsWith("https://")) {
            // Use URL proxy endpoint for direct URLs to avoid CORS
            audioUrl = `/api/voice/recordings/proxy?url=${encodeURIComponent(
              url,
            )}`;
          } else {
            // Fallback to relative URL
            audioUrl = url;
          }
        }

        if (audioUrl) {
          wavesurfer.load(audioUrl);
        } else {
          console.warn("No recording URL or ID available");
          toast.error("No recording URL available");
        }
      } catch (error) {
        console.error("Error loading recording:", error);
        toast.error("Failed to load recording");
      }
    }, 100);

    return () => {
      clearTimeout(timer);
      if (wavesurferRef.current) {
        if (wavesurferRef.current.isPlaying()) {
          wavesurferRef.current.stop();
        }
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
    };
  }, [recording, isOpen]);

  const togglePlayPause = () => {
    if (wavesurferRef.current) {
      wavesurferRef.current.playPause();
    }
  };

  const formatTime = (time) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const latencyMetrics = useMemo(() => {
    const assistantMessages = messages.filter(
      (m) => m?.role === "assistant" && m?.metadata,
    );

    if (assistantMessages.length === 0) {
      return { avgSTT: 0, avgLLM: 0, avgTTS: 0, avgTurn: 0 };
    }

    let totalSTT = 0;
    let totalLLM = 0;
    let totalTTS = 0;
    let totalTurn = 0;
    let countSTT = 0;
    let countLLM = 0;
    let countTTS = 0;
    let countTurn = 0;

    assistantMessages.forEach((msg) => {
      if (msg.metadata.transcription_duration_ms) {
        totalSTT += msg.metadata.transcription_duration_ms;
        countSTT++;
      }
      if (msg.metadata.llm_first_token_duration_ms) {
        totalLLM += msg.metadata.llm_first_token_duration_ms;
        countLLM++;
      }
      if (msg.metadata.audio_first_token_duration_ms) {
        totalTTS += msg.metadata.audio_first_token_duration_ms;
        countTTS++;
      }
      if (msg.metadata.end_user_perceived_latency_ms) {
        totalTurn += msg.metadata.end_user_perceived_latency_ms;
        countTurn++;
      }
    });

    return {
      avgSTT: countSTT > 0 ? Math.round(totalSTT / countSTT) : 0,
      avgLLM: countLLM > 0 ? Math.round(totalLLM / countLLM) : 0,
      avgTTS: countTTS > 0 ? Math.round(totalTTS / countTTS) : 0,
      avgTurn: countTurn > 0 ? Math.round(totalTurn / countTurn) : 0,
    };
  }, [messages]);

  const latencyPercentages = useMemo(() => {
    const total =
      latencyMetrics.avgSTT + latencyMetrics.avgLLM + latencyMetrics.avgTTS;
    if (total === 0) return { stt: 0, llm: 0, tts: 0 };

    return {
      stt: (latencyMetrics.avgSTT / total) * 100,
      llm: (latencyMetrics.avgLLM / total) * 100,
      tts: (latencyMetrics.avgTTS / total) * 100,
    };
  }, [latencyMetrics]);

  if (!aiCallControlId && !conversationId) return null;

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      {!hideTrigger && (
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={["h-8 w-8", triggerClassName].filter(Boolean).join(" ")}
            title="AI conversation history"
            onClick={(event) => {
              if (stopPropagation) event.stopPropagation();
            }}
          >
            <IconMessageCircle
              className={["h-4 w-4 text-violet-500", iconClassName]
                .filter(Boolean)
                .join(" ")}
            />
          </Button>
        </SheetTrigger>
      )}
      <SheetContent side="right">
        <SheetHeader className="gap-1">
          <SheetTitle className="flex items-center gap-2">
            <IconRobot className="h-5 w-5 text-violet-500 shrink-0" />
            <span className="truncate">
              {conversation?.name || "Voice Assistant Conversation"}
            </span>
          </SheetTitle>
          <SheetDescription asChild>
            <div className="space-y-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate" title={conversation?.id}>
                  {conversation?.id || aiCallControlId}
                </span>
                {(conversation?.id || aiCallControlId) && (
                  <CopyInline value={conversation?.id || aiCallControlId} />
                )}
              </div>

              {latencyMetrics.avgTurn > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground font-medium">
                      Average Latency
                    </span>
                    <span className="font-mono font-semibold text-blue-600">
                      {latencyMetrics.avgTurn}ms
                    </span>
                  </div>
                  <div className="flex h-2 rounded-full overflow-hidden bg-muted">
                    {latencyPercentages.stt > 0 && (
                      <div
                        className="bg-red-500"
                        style={{ width: `${latencyPercentages.stt}%` }}
                        title={`STT: ${latencyMetrics.avgSTT}ms`}
                      />
                    )}
                    {latencyPercentages.llm > 0 && (
                      <div
                        className="bg-green-500"
                        style={{ width: `${latencyPercentages.llm}%` }}
                        title={`LLM: ${latencyMetrics.avgLLM}ms`}
                      />
                    )}
                    {latencyPercentages.tts > 0 && (
                      <div
                        className="bg-orange-500"
                        style={{ width: `${latencyPercentages.tts}%` }}
                        title={`TTS: ${latencyMetrics.avgTTS}ms`}
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[9px] font-mono">
                    {latencyMetrics.avgSTT > 0 && (
                      <span className="text-red-600">
                        STT:{latencyMetrics.avgSTT}ms
                      </span>
                    )}
                    {latencyMetrics.avgLLM > 0 && (
                      <span className="text-green-600">
                        LLM:{latencyMetrics.avgLLM}ms
                      </span>
                    )}
                    {latencyMetrics.avgTTS > 0 && (
                      <span className="text-orange-600">
                        TTS:{latencyMetrics.avgTTS}ms
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 flex flex-col px-4 pb-4">
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex-1 min-h-0 flex flex-col"
          >
            <TabsList className="mt-2">
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="insights">Insights</TabsTrigger>
              <TabsTrigger value="metadata">Metadata</TabsTrigger>
              <TabsTrigger value="dynamic">Dynamic Variables</TabsTrigger>
            </TabsList>

            <TabsContent
              value="conversation"
              className="flex-1 min-h-0 flex flex-col overflow-hidden"
            >
              {!loadingConversation && !conversation && (
                <div className="text-sm text-muted-foreground p-2">
                  No AI conversation found for this call.
                </div>
              )}
              <AiConversationMessagesTab
                conversation={conversation}
                enabled={isOpen && activeTab === "conversation"}
                recording={recording}
                currentTime={currentTime}
                isPlaying={isPlaying}
                useDemoApiKey={usedDemoApiKey}
                hasAiCallControlId={hasAiCallControlId}
                onMessagesLoaded={setMessages}
                onSeek={(timeInSeconds) => {
                  if (wavesurferRef.current && duration > 0) {
                    const seekPosition = Math.min(timeInSeconds / duration, 1);
                    wavesurferRef.current.seekTo(seekPosition);
                    if (!isPlaying) {
                      wavesurferRef.current.play();
                    }
                  }
                }}
              />
            </TabsContent>

            <TabsContent
              value="insights"
              className="flex-1 min-h-0 overflow-auto py-2 space-y-2"
            >
              {!loadingConversation && !conversation && (
                <div className="text-sm text-muted-foreground p-2">
                  No AI conversation found for this call.
                </div>
              )}
              <AiConversationInsightsTab
                conversation={conversation}
                enabled={isOpen && activeTab === "insights"}
                useDemoApiKey={usedDemoApiKey}
                hasAiCallControlId={hasAiCallControlId}
              />
            </TabsContent>

            <TabsContent
              value="metadata"
              className="flex-1 min-h-0 overflow-auto py-2"
            >
              <AiConversationMetadataTab
                conversation={conversation}
                loading={loadingConversation}
              />
            </TabsContent>

            <TabsContent
              value="dynamic"
              className="flex-1 min-h-0 overflow-auto py-2"
            >
              <AiConversationDynamicVariablesTab
                conversation={conversation}
                enabled={isOpen && activeTab === "dynamic"}
                useDemoApiKey={usedDemoApiKey}
                hasAiCallControlId={hasAiCallControlId}
              />
            </TabsContent>
          </Tabs>

          {recording && activeTab === "conversation" && (
            <div className="pt-3 mb-3">
              <Card>
                <CardContent className="px-3 space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="font-medium">Recording</span>
                    <span>
                      {formatTime(currentTime)} / {formatTime(duration)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <div
                        ref={waveformRef}
                        className="w-full rounded border border-telnyx-green"
                        style={{ borderWidth: "1px" }}
                      />
                    </div>
                    <Button
                      onClick={togglePlayPause}
                      size="icon"
                      variant="outline"
                      className="shrink-0"
                    >
                      {isPlaying ? (
                        <Pause className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
