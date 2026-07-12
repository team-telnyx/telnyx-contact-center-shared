"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { IconCopy, IconCheck } from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Play, Pause } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import { notify } from "@/components/ToastNotify";
import AiConversationMessagesTab from "@/components/contact-center/AiConversationMessagesTab";
import AiConversationInsightsTab from "@/components/contact-center/AiConversationInsightsTab";
import AiConversationMetadataTab from "@/components/contact-center/AiConversationMetadataTab";
import AiConversationDynamicVariablesTab from "@/components/contact-center/AiConversationDynamicVariablesTab";
import AiConversationCostsTab from "@/components/contact-center/AiConversationCostsTab";

function formatTimestamp(value) {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");
    const yyyy = d.getFullYear();
    const MM = pad2(d.getMonth() + 1);
    const DD = pad2(d.getDate());
    const HH = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    const SSS = pad3(d.getMilliseconds());
    return `${yyyy}-${MM}-${DD} ${HH}:${mm}:${ss}.${SSS}`;
  } catch {
    return String(value);
  }
}

function formatMessageTimestamps(msg) {
  // Use sent_at for timestamp display
  const sent = msg?.sent_at || msg?.metadata?.sent_at;
  return sent ? formatTimestamp(sent) : "";
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

export default function ConversationMessagesSheet({ conversation, children }) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("conversation");
  const [recording, setRecording] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [messages, setMessages] = useState([]);
  const [fullConversation, setFullConversation] = useState(conversation);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const waveformRef = useRef(null);
  const wavesurferRef = useRef(null);

  // Calculate average latency metrics
  const latencyMetrics = useMemo(() => {
    const assistantMessages = messages.filter(
      (m) => m?.role === "assistant" && m?.metadata
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

  // Calculate percentages for progress bar
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

  // Fetch full conversation details when sheet opens
  useEffect(() => {
    if (!open || !conversation?.id) return;

    const fetchFullConversation = async () => {
      setLoadingConversation(true);
      try {
        // Fetch conversation using list endpoint with ID filter
        const convRes = await fetch(
          `/api/ai/conversations?id=${encodeURIComponent(conversation.id)}&pageSize=1`,
          { cache: "no-store" }
        );
        const convData = await convRes.json();

        if (convData.ok && convData.items && convData.items.length > 0) {
          setFullConversation(convData.items[0]);
        } else if (convData.ok && convData.data && convData.data.length > 0) {
          setFullConversation(convData.data[0]);
        } else {
          // Fallback to passed conversation if fetch fails
          setFullConversation(conversation);
        }
      } catch (err) {
        console.error("[ConversationMessagesSheet] Error fetching conversation:", err);
        // Fallback to passed conversation
        setFullConversation(conversation);
      } finally {
        setLoadingConversation(false);
      }
    };

    fetchFullConversation();
  }, [open, conversation?.id]);

  // Fetch recording when sheet opens and conversation is loaded
  useEffect(() => {
    if (!open || !fullConversation?.id) return;

    const fetchRecording = async () => {
      try {
        // Check if this is a phone call conversation
        const channel =
          fullConversation?.metadata?.telnyx_conversation_channel ||
          fullConversation?.metadata?.channel ||
          fullConversation?.channel;
        const isPhoneCall = channel === "phone_call" || channel === "call";

        if (!isPhoneCall) {
          console.log("[ConversationMessagesSheet] Not a phone call conversation, skipping recording fetch");
          return;
        }

        // Get call_session_id from metadata
        let callSessionId =
          fullConversation?.metadata?.call_session_id ||
          fullConversation?.metadata?.telnyx_call_session_id ||
          fullConversation?.call_session_id;

        if (!callSessionId) {
          // Try to fetch from webhook logs as fallback
          try {
            const webhookRes = await fetch(
              `/api/ai/conversations/${encodeURIComponent(
                fullConversation.id
              )}/webhook-logs?page[size]=100`,
              { cache: "no-store" }
            );
            const webhookData = await webhookRes.json();

            if (webhookData.ok && webhookData.data?.data) {
              for (const log of webhookData.data.data) {
                const payload = log?.payload || log?.data || log;
                if (payload?.call_session_id) {
                  callSessionId = payload.call_session_id;
                  break;
                }
                // Also check nested structures
                if (payload?.call?.call_session_id) {
                  callSessionId = payload.call.call_session_id;
                  break;
                }
              }
            }
          } catch (err) {
            console.error("[ConversationMessagesSheet] Error fetching webhook logs:", err);
          }
        }

        if (!callSessionId) {
          console.log("[ConversationMessagesSheet] No call_session_id found for conversation:", fullConversation.id);
          return;
        }

        // Fetch recordings
        const recordingsRes = await fetch(
          `/api/voice/recordings?call_session_id=${callSessionId}`,
          { cache: "no-store" }
        );
        const recordingsData = await recordingsRes.json();

        if (
          recordingsData.ok &&
          recordingsData.data &&
          recordingsData.data.length > 0
        ) {
          console.log("[ConversationMessagesSheet] Found recording:", recordingsData.data[0]);
          setRecording(recordingsData.data[0]);
        } else {
          console.log("[ConversationMessagesSheet] No recordings found for call_session_id:", callSessionId);
        }
      } catch (error) {
        console.error("[ConversationMessagesSheet] Error fetching recording:", error);
      }
    };

    fetchRecording();
  }, [open, fullConversation]);

  // Initialize WaveSurfer
  useEffect(() => {
    if (!recording || !waveformRef.current || !open) return;

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
        // Ignore expected abort errors when component unmounts during fetch
        if (error && (error.name === "AbortError" || String(error).includes("aborted"))) {
          return;
        }
        console.error("WaveSurfer error:", error);
        notify({ title: "Failed to load recording", variant: "error" });
      });

      try {
        const proxyUrl = `/api/voice/recordings/${recording.id}/stream`;
        wavesurfer.load(proxyUrl);
      } catch (error) {
        console.error("Error loading recording:", error);
        notify({ title: "Failed to load recording", variant: "error" });
      }
    }, 100);

    return () => {
      clearTimeout(timer);
      if (wavesurferRef.current) {
        try {
          // Check if playing first to avoid DOMException if not ready
          if (wavesurferRef.current.isPlaying()) {
            wavesurferRef.current.pause();
          }
        } catch (e) {
          // ignore
        }

        try {
          wavesurferRef.current.destroy();
        } catch (e) {
          // Ignore AbortError thrown synchronously during destroy
          if (e && e.name !== "AbortError" && !String(e).includes("aborted")) {
            console.error("WaveSurfer cleanup error:", e);
          }
        }
        wavesurferRef.current = null;
      }
    };
  }, [recording, open]);

  // Reset state when sheet closes
  useEffect(() => {
    if (!open) {
      setRecording(null);
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setFullConversation(conversation);
      setMessages([]);
    }
  }, [open, conversation]);

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

  const handleOpenChange = (newOpen) => {
    // Stop playback when closing the sheet
    if (!newOpen && wavesurferRef.current) {
      try {
        if (wavesurferRef.current.isPlaying()) {
          wavesurferRef.current.pause();
        }
      } catch (e) {
        // ignore
      }
    }
    setOpen(newOpen);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="right">
        <SheetHeader className="gap-1">
          <SheetTitle className="truncate">
            {fullConversation?.name || fullConversation?.id || conversation?.name || conversation?.id}
          </SheetTitle>
          <SheetDescription asChild>
            <div className="space-y-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate" title={fullConversation?.id || conversation?.id}>
                  {fullConversation?.id || conversation?.id}
                </span>
                {(fullConversation?.id || conversation?.id) && (
                  <CopyInline value={fullConversation?.id || conversation?.id} />
                )}
              </div>

              {/* Average Latency Metrics */}
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
        <div className="flex-1 min-h-0 flex flex-col px-4">
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
              <TabsTrigger value="costs">Costs</TabsTrigger>
            </TabsList>

            <TabsContent
              value="conversation"
              className="flex-1 min-h-0 flex flex-col"
            >
              <AiConversationMessagesTab
                conversation={fullConversation || conversation}
                enabled={open && activeTab === "conversation"}
                recording={recording}
                currentTime={currentTime}
                isPlaying={isPlaying}
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
              <AiConversationInsightsTab
                conversation={fullConversation || conversation}
                enabled={open && activeTab === "insights"}
              />
            </TabsContent>

            <TabsContent
              value="metadata"
              className="flex-1 min-h-0 overflow-auto py-2"
            >
              <AiConversationMetadataTab
                conversation={fullConversation || conversation}
                loading={loadingConversation}
              />
            </TabsContent>

            <TabsContent
              value="dynamic"
              className="flex-1 min-h-0 overflow-auto py-2"
            >
              <AiConversationDynamicVariablesTab
                conversation={fullConversation || conversation}
                enabled={open && activeTab === "dynamic"}
              />
            </TabsContent>

            <TabsContent
              value="costs"
              className="flex-1 min-h-0 overflow-auto py-2"
            >
              <AiConversationCostsTab conversation={fullConversation || conversation} />
            </TabsContent>
          </Tabs>

          {/* Recording Player - Compact Bottom Dock */}
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
