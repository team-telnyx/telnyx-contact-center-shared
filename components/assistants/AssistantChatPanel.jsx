"use client";

import { useEffect, useRef, useState } from "react";
import { IconMessageCircle, IconRobot, IconSend, IconUser } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { Message, MessageAvatar, MessageContent } from "@/components/ai-elements/message";

const ConversationScrollButton = () => null;

export default function AssistantChatPanel({ assistant, open, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [initializing, setInitializing] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open || !assistant?.id) return;
    let cancelled = false;
    setMessages(assistant.greeting ? [{ id: "greeting", role: "assistant", text: assistant.greeting }] : []);
    setInput(""); setConversationId(""); setInitializing(true);
    fetch("/api/ai/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Chat with ${assistant.name || assistant.id}`, metadata: { assistant_id: assistant.id, assistant_name: assistant.name || "", channel: "web_chat" } }),
    }).then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => { if (!response.ok || !data?.ok) throw new Error(data?.error || "Could not start chat"); if (!cancelled) setConversationId(data.id || data.conversation?.id || ""); })
      .catch((error) => { if (!cancelled) setMessages([{ id: "error", role: "assistant", text: error.message }]); })
      .finally(() => { if (!cancelled) setInitializing(false); });
    return () => { cancelled = true; };
  }, [assistant, open]);

  useEffect(() => { if (!initializing && conversationId) inputRef.current?.focus(); }, [conversationId, initializing, messages]);

  async function send() {
    const content = input.trim();
    if (!content || !conversationId || sending) return;
    const userMessage = { id: `user-${Date.now()}`, role: "user", text: content };
    setMessages((current) => [...current, userMessage]); setInput(""); setSending(true);
    try {
      const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistant.id)}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, conversation_id: conversationId }) });
      const data = await response.json();
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Chat failed");
      const text = data.content || data.response?.content || data.raw?.content || data.raw?.data?.content || "";
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", text: text || "The assistant returned an empty response." }]);
    } catch (error) {
      setMessages((current) => [...current, { id: `error-${Date.now()}`, role: "assistant", text: error.message }]);
    } finally { setSending(false); }
  }

  return <Sheet open={open} onOpenChange={(next) => !next && onClose()}><SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-xl"><SheetHeader className="border-b px-6 py-4"><SheetTitle className="flex items-center gap-2"><IconMessageCircle className="size-5 text-emerald-500" />{assistant?.name || "Assistant Chat"}</SheetTitle></SheetHeader><div className="relative min-h-0 flex-1">{initializing ? <div className="space-y-4 p-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-3/4" /></div> : <Conversation className="h-full"><ConversationContent>{!messages.length ? <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground"><IconMessageCircle className="size-12" />Start chatting with {assistant?.name || "the assistant"}</div> : null}{messages.map((message) => { const user = message.role === "user"; return <Message key={message.id} from={user ? "user" : "assistant"}><MessageAvatar className={user ? "ring-emerald-500" : "ring-orange-500"} icon={user ? <IconUser className="size-4 text-emerald-500" /> : <IconRobot className="size-4 text-orange-500" />} /><MessageContent variant="contained"><div className="whitespace-pre-wrap">{message.text}</div></MessageContent></Message>; })}{sending ? <Message from="assistant"><MessageAvatar icon={<IconRobot className="size-4" />} /><MessageContent variant="contained"><span className="animate-pulse">● ● ●</span></MessageContent></Message> : null}</ConversationContent><ConversationScrollButton /></Conversation>}</div><div className="flex gap-2 border-t p-4"><Input ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="Type your message..." disabled={initializing || !conversationId} /><Button size="icon" onClick={send} disabled={!input.trim() || sending || !conversationId}><IconSend className="size-4" /></Button></div></SheetContent></Sheet>;
}
