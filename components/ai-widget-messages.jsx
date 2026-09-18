"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  Image as ImageIcon,
  Mic,
  RotateCcw,
  SendHorizontal,
} from "lucide-react";
import { useClient, useTranscript } from "@telnyx/ai-agent-lib";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notify } from "@/components/ToastNotify";
import { useAIWidgetUI } from "@/components/ai-widget-ui-provider";
import { normalizeAITranscript } from "@/lib/ai/widget-ui-state.mjs";
import { stripTtsExpressionTags } from "@/lib/ai/tts-expression-text.mjs";
import { TtsExpressionInline } from "@/components/tts-expression-text";

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function getSafeAttachmentUrl(value) {
  const url = String(value || "");
  return /^(https?:|blob:|data:image\/)/i.test(url) ? url : null;
}

export function AIWidgetMessages({ compact = false }) {
  const client = useClient();
  const transcript = useTranscript();
  const { hasActiveConversation, reportError, status } = useAIWidgetUI();
  const [input, setInput] = useState("");
  const [pendingMessages, setPendingMessages] = useState([]);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const scrollRef = useRef(null);
  const endRef = useRef(null);

  const messages = useMemo(
    () => normalizeAITranscript(transcript, pendingMessages),
    [pendingMessages, transcript]
  );

  useEffect(() => {
    if (!pendingMessages.length) return;
    const timeout = window.setTimeout(() => {
      setPendingMessages((current) =>
        current.filter(
          (pending) =>
            !transcript.some((item) => {
              const itemTime = new Date(item.timestamp || 0).getTime();
              const pendingTime = new Date(pending.timestamp || 0).getTime();
              return (
                item.role === "user" &&
                String(item.content || "").trim() === pending.content.trim() &&
                Math.abs(itemTime - pendingTime) < 30_000
              );
            })
        )
      );
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [pendingMessages.length, transcript]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const frame = window.requestAnimationFrame(() => {
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (distanceFromBottom < 100) {
        endRef.current?.scrollIntoView({ behavior: "smooth" });
        setShowNewMessages(false);
      } else if (messages.length) {
        setShowNewMessages(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages]);

  const sendMessage = async () => {
    const content = input.trim();
    if (!client || !content || !hasActiveConversation) return;

    const pending = {
      id: `pending-${crypto.randomUUID?.() || Date.now()}`,
      content,
      timestamp: new Date(),
      status: "sending",
    };
    setPendingMessages((current) => [...current, pending]);
    setInput("");

    try {
      await client.sendConversationMessage(content);
    } catch (error) {
      setPendingMessages((current) =>
        current.map((item) => (item.id === pending.id ? { ...item, status: "failed" } : item))
      );
      reportError(error);
    }
  };

  const retryMessage = (message) => {
    setPendingMessages((current) => current.filter((item) => item.id !== message.id));
    setInput(message.content);
  };

  const copyMessage = async (content) => {
    try {
      await navigator.clipboard.writeText(content);
      notify({ title: "Message copied", variant: "success" });
    } catch {
      notify({ title: "Could not copy message", variant: "error" });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
          if (nearBottom) setShowNewMessages(false);
        }}
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center p-5 text-center">
            <div>
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
                <Bot className="size-6 text-emerald-500" />
              </div>
              <p className="text-sm font-medium">
                {hasActiveConversation ? status.description : "Start a call to talk with the assistant"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Voice and typed messages will appear here in real time.
              </p>
            </div>
          </div>
        ) : (
          <div className={compact ? "space-y-2 p-3" : "space-y-3 p-4"} aria-live="polite">
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const showAvatar = previous?.role !== message.role;
              const content = message.role === "assistant"
                ? stripTtsExpressionTags(message.content)
                : message.content;
              if (!String(content || "").trim() && !message.attachments?.length) return null;

              return (
                <div key={message.id} className={`group flex gap-2 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  {message.role === "assistant" && (
                    <div className={`flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-zinc-950 ${showAvatar ? "opacity-100" : "opacity-0"}`}>
                      <Bot className="size-3.5" />
                    </div>
                  )}
                  <div className="max-w-[78%]">
                    <div
                      className={`relative rounded-2xl px-3 py-2 text-sm shadow-sm ${
                        message.role === "user"
                          ? "rounded-br-md bg-emerald-500 text-zinc-950"
                          : "rounded-bl-md border border-border bg-background text-foreground"
                      } ${message.failed ? "border-red-500 bg-red-500/10" : ""}`}
                    >
                      <p className="whitespace-pre-wrap break-words">
                        {message.role === "assistant" ? <TtsExpressionInline>{message.content}</TtsExpressionInline> : content}
                      </p>
                      {message.attachments?.map((attachment) => {
                        const url = getSafeAttachmentUrl(attachment.url);
                        if (!url) return null;
                        return (
                          <a key={url} href={url} target="_blank" rel="noreferrer" className="mt-2 block overflow-hidden rounded-lg border">
                            {attachment.type === "image" ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={url} alt="Message attachment" className="max-h-40 w-full object-cover" />
                            ) : (
                              <span className="flex items-center gap-1 p-2 text-xs"><ImageIcon className="size-3" /> Attachment</span>
                            )}
                          </a>
                        );
                      })}
                    </div>
                    <div className={`mt-1 flex items-center gap-1 text-[10px] text-muted-foreground ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                      <span>{formatTime(message.timestamp)}</span>
                      {message.pending && <span>Sending…</span>}
                      {!message.pending && !message.failed && message.role === "user" && <Check className="size-3" />}
                      {message.failed && (
                        <button type="button" className="inline-flex items-center gap-1 text-red-500" onClick={() => retryMessage(message)}>
                          <RotateCcw className="size-3" /> Retry
                        </button>
                      )}
                      {message.role === "assistant" && (
                        <button type="button" className="ml-1 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => copyMessage(content)} aria-label="Copy message">
                          <Copy className="size-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  {message.role === "user" && (
                    <div className={`flex size-7 shrink-0 items-center justify-center rounded-full bg-orange-400 text-white ${showAvatar ? "opacity-100" : "opacity-0"}`}>
                      <Mic className="size-3.5" />
                    </div>
                  )}
                </div>
              );
            })}
            {status.key === "thinking" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex size-7 items-center justify-center rounded-full bg-emerald-500/10"><Bot className="size-3.5 text-emerald-500" /></span>
                <span className="rounded-2xl border bg-background px-3 py-2">Thinking<span className="animate-pulse">…</span></span>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}

        {showNewMessages && (
          <Button type="button" size="sm" className="sticky bottom-2 left-1/2 h-7 -translate-x-1/2 rounded-full text-xs" onClick={() => endRef.current?.scrollIntoView({ behavior: "smooth" })}>
            <ChevronDown className="mr-1 size-3" /> New messages
          </Button>
        )}
      </div>

      <div className={`${compact ? "p-3" : "p-4"} shrink-0 border-t border-border bg-background/90 backdrop-blur`}>
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-background p-1.5 focus-within:border-emerald-500/60 focus-within:ring-2 focus-within:ring-emerald-500/15">
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={hasActiveConversation ? "Type a message…" : "Start a call to send a message"}
            disabled={!hasActiveConversation}
            className="h-9 min-w-0 flex-1 border-0 bg-transparent px-2 text-sm shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
          />
          <Button type="button" size="icon" className="size-9 shrink-0 rounded-xl bg-emerald-500 text-zinc-950 hover:bg-emerald-400" disabled={!hasActiveConversation || !input.trim()} onClick={sendMessage} aria-label="Send message">
            <SendHorizontal className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
