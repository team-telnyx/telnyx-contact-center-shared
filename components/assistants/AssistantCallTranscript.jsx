"use client";

import { AudioLines, Loader2, Mic, Volume2 } from "lucide-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { stripTtsExpressionTags } from "@/lib/ai/tts-expression-text.mjs";

const userBubble = "ml-auto rounded-br-md bg-emerald-500 text-zinc-950";
const assistantBubble = "rounded-bl-md border border-border bg-muted text-foreground";
const bubble = "max-w-[92%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm";

export default function AssistantCallTranscript({ transcript, active, userState, speakingItemId, endRef }) {
  const tUi = useUiText();
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3" aria-label={tUi("Conversation transcript")}>
      {transcript.map(item => {
        const user = item.role === "user";
        const speaking = active && !user && item.id === speakingItemId;
        return (
          <div key={item.id} data-call-message-role={item.role} className={`${bubble} ${user ? userBubble : assistantBubble}`}>
            <div className={`mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide ${user ? "text-zinc-950/70" : "text-muted-foreground"}`}>
              {user ? <Mic aria-hidden="true" className="size-3" /> : <Volume2 aria-hidden="true" className={`size-3 ${speaking ? "text-emerald-500" : ""}`} />}
              <span>{tUi(user ? "You" : "Assistant")}</span>
              {speaking && <span role="status" aria-label={tUi("Assistant is speaking")} className="ml-auto flex items-center gap-1 text-emerald-500"><AudioLines aria-hidden="true" className="size-3.5 motion-safe:animate-pulse" />{tUi("Speaking")}</span>}
            </div>
            {user ? item.content : stripTtsExpressionTags(item.content)}
          </div>
        );
      })}
      {active && userState !== "idle" && (
        <div data-call-message-role="user" className={`${bubble} ${userBubble}`}>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-950/70"><Mic aria-hidden="true" className="size-3" />{tUi("You")}</div>
          <div role="status" className="flex items-center gap-2">
            {userState === "speaking" ? <AudioLines aria-hidden="true" className="size-4 motion-safe:animate-pulse" /> : <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />}
            {tUi(userState === "speaking" ? "You're speaking…" : "Transcribing…")}
          </div>
        </div>
      )}
      {!transcript.length && (!active || userState === "idle") && <p className="px-3 py-4 text-center text-xs leading-relaxed text-muted-foreground">{tUi("Voice and typed messages will appear here in real time.")}</p>}
      <div ref={endRef} />
    </div>
  );
}
