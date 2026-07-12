"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Skeleton } from "@/components/ui/skeleton";
import { IconRobot, IconUser } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

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
  const sent = msg?.sent_at || msg?.metadata?.sent_at;
  return sent ? formatTimestamp(sent) : "";
}

export default function AiConversationMessagesTab({
  conversation,
  enabled,
  recording,
  currentTime,
  isPlaying,
  useDemoApiKey = false,
  hasAiCallControlId = false,
  onMessagesLoaded,
  onSeek,
}) {
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([]);
  const messageRefs = useRef({});
  const conversationRef = useRef(null);

  const toolResponsesById = useMemo(() => {
    const map = new Map();
    for (const msg of messages) {
      if (msg?.role === "tool" && msg?.tool_call_id) {
        map.set(msg.tool_call_id, msg);
      }
    }
    return map;
  }, [messages]);

  const linkedToolCallIds = useMemo(() => {
    const set = new Set();
    for (const msg of messages) {
      if (msg?.role === "assistant" && Array.isArray(msg?.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (call?.id) set.add(call.id);
        }
      }
    }
    return set;
  }, [messages]);

  const messageTimeline = useMemo(() => {
    if (!recording || messages.length === 0) return [];

    const timeline = messages
      .map((msg, index) => {
        const timestamp = msg?.sent_at || msg?.metadata?.sent_at;
        if (!timestamp) return null;

        try {
          const time = new Date(timestamp).getTime();
          return { index, time, message: msg };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);

    if (timeline.length === 0) return [];

    const explicitRecordingStart = recording?.started_at || recording?.recording_started_at;
    const fallbackRecordingStart = recording?.created_at || conversation?.created_at;
    let recordingStartTime = explicitRecordingStart
      ? new Date(explicitRecordingStart).getTime()
      : fallbackRecordingStart
      ? new Date(fallbackRecordingStart).getTime()
      : timeline[0].time;
    const durationMs = Number(recording.duration_millis || 0);
    const firstMessageTime = timeline[0].time;
    const implausibleStart = !Number.isFinite(recordingStartTime) || recordingStartTime > firstMessageTime + 2000 || (durationMs > 0 && firstMessageTime - recordingStartTime > durationMs + 30000);
    if (implausibleStart) recordingStartTime = firstMessageTime;

    const result = timeline.map((item, idx) => {
      const relativeStart = (item.time - recordingStartTime) / 1000;
      const nextItem = timeline[idx + 1];
      const relativeEnd = nextItem
        ? (nextItem.time - recordingStartTime) / 1000
        : recording.duration_millis
        ? recording.duration_millis / 1000
        : relativeStart + 5;

      return {
        ...item,
        relativeStart: Math.max(0, relativeStart),
        relativeEnd: Math.max(0, relativeEnd),
        duration: Math.max(0, relativeEnd - relativeStart),
      };
    });

    return result;
  }, [messages, recording, conversation?.created_at]);

  const currentMessageIndex = useMemo(() => {
    if (!isPlaying || !recording || messageTimeline.length === 0) return -1;

    // Account for 500ms offset to match seek behavior when clicking messages
    const adjustedTime = currentTime + 1;

    for (let i = messageTimeline.length - 1; i >= 0; i--) {
      const item = messageTimeline[i];
      if (adjustedTime >= item.relativeStart) {
        return item.index;
      }
    }
    return -1;
  }, [currentTime, isPlaying, recording, messageTimeline]);

  useEffect(() => {
    if (!enabled) return;
    if (!conversation?.id) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const url = `/api/ai/conversations/${encodeURIComponent(
          conversation.id
        )}/messages${useDemoApiKey ? "?useDemoApiKey=true" : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        const data = await res.json();
        if (!cancelled && res.ok && data?.ok) {
          const msgs = Array.isArray(data.messages) ? data.messages : [];
          setMessages(msgs);
          if (onMessagesLoaded) {
            onMessagesLoaded(msgs);
          }
        } else if (!cancelled && hasAiCallControlId && !useDemoApiKey) {
          // Check if we should retry with demo API key
          // Retry if: 502 (gateway error), 403, 404, or error message indicates "not found"
          const shouldRetry = !res.ok ||
            res.status === 403 ||
            res.status === 404 ||
            res.status === 502 ||
            (data?.error && (
              data.error.includes("404") ||
              data.error.includes("not found") ||
              data.error.includes("Resource not found")
            ));

          if (shouldRetry) {
            // Fallback: try with demo API key if regular fetch failed
            const demoUrl = `/api/ai/conversations/${encodeURIComponent(
              conversation.id
            )}/messages?useDemoApiKey=true`;
            const demoRes = await fetch(demoUrl, { cache: "no-store" });
            const demoData = await demoRes.json();
            if (!cancelled && demoRes.ok && demoData?.ok) {
              const msgs = Array.isArray(demoData.messages) ? demoData.messages : [];
              setMessages(msgs);
              if (onMessagesLoaded) {
                onMessagesLoaded(msgs);
              }
            }
          }
        }
      } catch (_) {}
      if (!cancelled) setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [conversation?.id, enabled, useDemoApiKey, hasAiCallControlId]);

  useEffect(() => {
    if (currentMessageIndex === -1 || !isPlaying) return;

    const messageElement = messageRefs.current[currentMessageIndex];
    if (messageElement) {
      setTimeout(() => {
        messageElement.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "nearest",
        });
      }, 100);
    }
  }, [currentMessageIndex, isPlaying]);

  return (
    <Conversation
      className="flex-1 min-h-0 bg-muted rounded-lg overflow-y-auto"
      ref={conversationRef}
    >
      <ConversationContent>
        {loading && (
          <div className="space-y-2">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="text-sm text-muted-foreground">No messages</div>
        )}
        {[...messages].reverse().map((m, reversedIdx) => {
          const originalIdx = messages.length - 1 - reversedIdx;
          const isCurrentMessage = originalIdx === currentMessageIndex;
          const role = m?.role;
          const isUser = role === "user";
          const isAssistant = role === "assistant";
          const isTool = role === "tool";

          if (isTool) {
            if (linkedToolCallIds.has(m?.tool_call_id)) {
              return null;
            }
            let json = {};
            try {
              json = m?.text ? JSON.parse(m.text) : {};
            } catch {
              json = { value: m?.text };
            }
            return (
              <div
                key={reversedIdx}
                className="py-0"
                ref={(el) => {
                  if (el) messageRefs.current[originalIdx] = el;
                }}
              >
                <Tool defaultOpen={false}>
                  <ToolHeader type="tool" state="output-available" />
                  <ToolContent>
                    <CodeBlock
                      code={JSON.stringify(json, null, 2)}
                      language="json"
                    >
                      <CodeBlockCopyButton />
                    </CodeBlock>
                  </ToolContent>
                </Tool>
                <div className="text-[10px] text-muted-foreground mb-0">
                  {formatMessageTimestamps(m)}
                </div>
              </div>
            );
          }
          return (
            <div
              key={reversedIdx}
              ref={(el) => {
                if (el) messageRefs.current[originalIdx] = el;
              }}
              className="relative"
            >
              <Message from={isUser ? "user" : "assistant"}>
                {!isTool && m?.tool_calls === null && m?.text !== "" && (
                  <>
                    <MessageAvatar
                      className={
                        isUser ? "ring-emerald-500" : "ring-orange-500"
                      }
                      icon={
                        isUser ? (
                          <IconUser className="size-4 text-emerald-600" />
                        ) : (
                          <IconRobot className="size-4 text-orange-500" />
                        )
                      }
                    />
                    <MessageContent
                      variant="contained"
                      className={cn(
                        "relative",
                        isCurrentMessage &&
                          isPlaying &&
                          "ring-2 ring-orange-500 shadow-2xl shadow-orange-500/50",
                        recording && onSeek && "cursor-pointer hover:opacity-90"
                      )}
                      onClick={() => {
                        if (recording && onSeek) {
                          const item = messageTimeline.find(
                            (t) => t.index === originalIdx
                          );
                          if (item) {
                            // Subtract 500ms to start slightly before the message to avoid speech cut off
                            const seekTime = Math.max(
                              0,
                              item.relativeStart - 1
                            );
                            onSeek(seekTime);
                          }
                        }
                      }}
                    >
                      {m?.text && (
                        <div className="whitespace-pre-wrap">{m.text}</div>
                      )}
                    </MessageContent>
                  </>
                )}
              </Message>

              {Array.isArray(m?.tool_calls) && m.tool_calls.length > 0 && (
                <div className="space-y-2">
                  {m.tool_calls.map((call) => {
                    const funcName =
                      call?.function?.name || call?.type || "tool";
                    let argsObj = call?.function?.arguments;
                    try {
                      if (typeof argsObj === "string") {
                        argsObj = JSON.parse(argsObj);
                      }
                    } catch {
                      // Keep as string if parsing fails
                    }
                    const responseMsg = call?.id
                      ? toolResponsesById.get(call.id)
                      : undefined;
                    let responseObj = responseMsg?.text;
                    try {
                      if (typeof responseObj === "string") {
                        responseObj = JSON.parse(responseObj);
                      }
                    } catch {
                      // Keep as string if parsing fails
                    }
                    const state = responseMsg
                      ? "output-available"
                      : "input-available";
                    return (
                      <Tool key={call?.id || funcName} defaultOpen={false}>
                        <ToolHeader type={funcName} state={state} />
                        <ToolContent>
                          <ToolInput input={argsObj} />
                          {responseMsg && <ToolOutput output={responseObj} />}
                        </ToolContent>
                        <div className="text-[10px] text-muted-foreground -mt-1 px-4 pb-2">
                          {formatMessageTimestamps(responseMsg || m)}
                        </div>
                      </Tool>
                    );
                  })}
                </div>
              )}

              <div className={isUser ? "text-right -mt-1" : "text-left -mt-1"}>
                {m?.text !== "" && (
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] text-muted-foreground mb-2">
                      {formatMessageTimestamps(m)}
                    </span>
                    {isAssistant && m?.metadata && (
                      <>
                        {(m.metadata.transcription_duration_ms ||
                          m.metadata.llm_first_token_duration_ms ||
                          m.metadata.audio_first_token_duration_ms ||
                          m.metadata.end_user_perceived_latency_ms) && (
                          <div className="flex items-center gap-1 text-[9px] font-mono">
                            {m.metadata.transcription_duration_ms && (
                              <>
                                <span className="px-1 py-0.5 rounded bg-red-500/10 text-red-600 border border-red-500/20">
                                  STT:{m.metadata.transcription_duration_ms}ms
                                </span>
                                {(m.metadata.llm_first_token_duration_ms ||
                                  m.metadata.audio_first_token_duration_ms) && (
                                  <span className="text-muted-foreground">
                                    +
                                  </span>
                                )}
                              </>
                            )}
                            {m.metadata.llm_first_token_duration_ms && (
                              <>
                                <span className="px-1 py-0.5 rounded bg-green-500/10 text-green-600 border border-green-500/20">
                                  LLM:{m.metadata.llm_first_token_duration_ms}
                                  ms
                                </span>
                                {m.metadata.audio_first_token_duration_ms && (
                                  <span className="text-muted-foreground">
                                    +
                                  </span>
                                )}
                              </>
                            )}
                            {m.metadata.audio_first_token_duration_ms && (
                              <>
                                <span className="px-1 py-0.5 rounded bg-orange-500/10 text-orange-600 border border-orange-500/20">
                                  TTS:{m.metadata.audio_first_token_duration_ms}
                                  ms
                                </span>
                              </>
                            )}
                            {m.metadata.end_user_perceived_latency_ms && (
                              <>
                                <span className="text-muted-foreground">=</span>
                                <span className="px-1 py-0.5 rounded bg-blue-500/10 text-blue-600 border border-blue-500/20 font-semibold">
                                  TURN:
                                  {m.metadata.end_user_perceived_latency_ms}
                                  ms
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </ConversationContent>
    </Conversation>
  );
}
