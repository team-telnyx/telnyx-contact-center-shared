"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ChevronDown,
  Clock3,
  LockKeyhole,
  Radio,
  RefreshCw,
  UserRound,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { channelDefinition } from "@/lib/acd/channel-registry.mjs";
import { InteractionChannel } from "./InteractionChannel";
import InteractionSla from "./InteractionSla";
import ChatMessageBubble from "./ChatMessageBubble";
import EmailAttachments from "@/components/email/EmailAttachments";
import EmailMessageStatus from "@/components/email/EmailMessageStatus";
import EmailBody from "@/components/email/EmailBody";

const address = (value) =>
  Array.isArray(value)
    ? value.map(address).join(", ")
    : typeof value === "object" && value
      ? value.email || value.address || value.name || ""
      : String(value || "");
const date = (value) => (value ? new Date(value).toLocaleString() : "—");
function EmailMessage({ message, preview }) {
  const [expanded, setExpanded] = useState(true);
  const draft=message.status==='draft';
  const agentName=[message.first_name,message.last_name].filter(Boolean).join(' ')||message.agent_username;
  return (
    <article data-testid={draft?'email-draft-preview':'email-message-preview'} className={`overflow-hidden rounded-xl border bg-card shadow-sm ${draft?'border-amber-500/40':''}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-muted/30"
      >
        <span className="min-w-0">
          <span className="block break-words text-sm font-semibold">
            {(draft&&agentName)||address(message.envelope?.from) ||
              [message.first_name, message.last_name]
                .filter(Boolean)
                .join(" ") ||
              message.sender_role}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          <EmailMessageStatus message={message}/>
          <time className="text-xs text-muted-foreground">
            {draft?`Last saved ${date(message.updated_at)}`:date(message.created_at)}
          </time>
        </span>
        <ChevronDown
          className={`mt-1 size-4 shrink-0 transition ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="space-y-3 border-t p-3">
          <div className="space-y-1 break-words text-xs text-muted-foreground">
            {draft&&message.envelope?.subject&&<p>Subject: {message.envelope.subject}</p>}
            {message.envelope?.to && <p>To: {address(message.envelope.to)}</p>}
            {message.envelope?.cc?.length > 0 && (
              <p>Cc: {address(message.envelope.cc)}</p>
            )}
          </div>
          <EmailBody message={message} settings={preview} />
          <EmailAttachments files={message.attachments}/>
          {message.deliveries?.length > 0 && (
            <div
              className="flex flex-wrap gap-2"
              aria-label="Delivery evidence"
            >
              {message.deliveries.map((d, i) => (
                <Badge variant="outline" key={i}>
                  {d.kind === "bcc"
                    ? "Private recipient"
                    : d.address || "Recipient"}
                  : {d.status}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function ConversationReader({ workItemId, onSelectEpisode }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [connected, setConnected] = useState(false);
  const [newMessages, setNewMessages] = useState(0),
    [olderLoading, setOlderLoading] = useState(false),
    [retry, setRetry] = useState(0),
    [contextOpen, setContextOpen] = useState(false);
  const scroller = useRef(null),
    following = useRef(true),
    messageIds = useRef(new Set()),
    olderRequest = useRef(null);
  const scrollEnd = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    following.current = true;
    setNewMessages(0);
  };
  useEffect(() => {
    setData(null);
    setError(null);
    setConnected(false);
    setNewMessages(0);
    following.current = true;
    messageIds.current = new Set();
    let active = true;
    const events = new EventSource(
      `/api/contact-center/interactions/${encodeURIComponent(workItemId)}/conversation?stream=1`,
    );
    events.addEventListener("conversation", (event) => {
      if (!active) return;
      const update = JSON.parse(event.data),
        next = update.snapshot;
      if (!next) return;
      if (update.reset) messageIds.current = new Set();
      const added = next.messages.filter(
        (message) => !messageIds.current.has(message.id),
      ).length;
      for (const message of next.messages) messageIds.current.add(message.id);
      setData((previous) => {
        if (update.reset) previous = null;
        const merged = new Map(
          (previous?.messages || []).map((m) => [m.id, m]),
        );
        for (const message of next.messages) merged.set(message.id, message);
        return {
          ...next,
          hasMore: previous?.hasMore ?? next.hasMore,
          before: previous?.before ?? next.before,
          messages: [...merged.values()].sort((a, b) =>
            BigInt(a.seq) < BigInt(b.seq) ? -1 : 1,
          ),
        };
      });
      setConnected(true);
      setError(null);
      if (following.current) requestAnimationFrame(scrollEnd);
      else if (added) setNewMessages((count) => count + added);
    });
    events.onerror = () => {
      if (active) {
        setConnected(false);
        setError("Live connection interrupted. Reconnecting…");
      }
    };
    return () => {
      active = false;
      events.close();
      olderRequest.current?.abort();
    };
  }, [workItemId, retry]);
  async function loadOlder() {
    olderRequest.current?.abort();
    const controller = new AbortController();
    olderRequest.current = controller;
    setOlderLoading(true);
    const el = scroller.current,
      height = el?.scrollHeight || 0;
    try {
      const response = await fetch(
        `/api/contact-center/interactions/${workItemId}/conversation?before=${data.before}`,
        { signal: controller.signal, cache: "no-store" },
      );
      if (!response.ok)
        throw new Error("Earlier messages are unavailable. Try again.");
      const { snapshot } = await response.json();
      if (controller.signal.aborted) return;
      setData((previous) => {
        const merged = new Map(
          [...snapshot.messages, ...previous.messages].map((m) => [m.id, m]),
        );
        return {
          ...previous,
          messages: [...merged.values()],
          hasMore: snapshot.hasMore,
          before: snapshot.before,
        };
      });
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - height;
      });
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message);
    } finally {
      if (!controller.signal.aborted) setOlderLoading(false);
    }
  }
  if (!data)
    return (
      <div className="flex min-h-72 flex-col gap-5 p-6">
        {error ? (
          <div role="alert" className="rounded-xl border p-5 text-sm">
            Conversation unavailable.{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetry((v) => v + 1)}
            >
              Retry
            </Button>
          </div>
        ) : (
          <>
            <Skeleton className="h-12 w-3/5" />
            <Skeleton className="h-24 w-4/5" />
            <Skeleton className="h-20 w-3/5 self-end" />
            <Skeleton className="h-28 w-4/5" />
          </>
        )}
      </div>
    );
  const work = data.work,
    definition = channelDefinition(work.channel),
    email = definition.viewer === "email";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b bg-card px-4 py-3 pr-12">
        <div className="flex min-w-0 items-center gap-3">
          <InteractionChannel channel={work.channel} />
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold tracking-tight">
              {data.mailbox?.subject ||
                work.customer_name ||
                work.customer_address ||
                definition.label + " conversation"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {definition.label} ·{" "}
              {work.queue_display_name || work.queue_name || "No queue"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5">
            <LockKeyhole className="size-3" />
            Read only
          </Badge>
          <Badge variant="secondary">{work.state}</Badge>
          <InteractionSla sla={data.sla} />
          <Button
            variant="outline"
            size="sm"
            className="lg:hidden"
            aria-expanded={contextOpen}
            onClick={() => setContextOpen((v) => !v)}
          >
            Context
          </Button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_260px]">
        <section className="relative flex min-h-0 flex-col bg-muted/20">
          <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              Conversation · {data.messages.length}
              {data.hasMore ? "+" : ""} messages
              {email&&data.drafts?.length>0&&` · ${data.drafts.length} draft`}
            </span>
            <span className="flex items-center gap-1.5">
              <Radio
                className={`size-3 ${connected ? "text-emerald-600" : "text-amber-600"}`}
              />
              {connected ? "Connected" : "Reconnecting"}
            </span>
          </div>
          {error && (
            <div
              role="status"
              className="bg-amber-500/10 px-6 py-2 text-xs text-amber-800 dark:text-amber-200"
            >
              {error}
            </div>
          )}
          <div
            ref={scroller}
            onScroll={() => {
              const el = scroller.current;
              following.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 90;
              if (following.current) setNewMessages(0);
            }}
            className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${email?'p-3':'px-5 py-5 sm:px-8'}`}
          >
            <div className={email?'w-full space-y-3':'mx-auto max-w-3xl space-y-5'}>
              {data.hasMore && (
                <div className="text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={olderLoading}
                    onClick={loadOlder}
                  >
                    {olderLoading ? (
                      <RefreshCw className="mr-2 size-3 animate-spin" />
                    ) : null}
                    Earlier messages
                  </Button>
                </div>
              )}
              {!data.messages.length && (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  No messages in this interaction yet.
                </div>
              )}
              {data.messages.map((message, index) => (
                <div key={message.id}>
                  {(index === 0 ||
                    new Date(
                      data.messages[index - 1].created_at,
                    ).toDateString() !==
                      new Date(message.created_at).toDateString()) && (
                    <div className={`${email?'mb-3':'mb-5'} text-center text-[11px] font-medium text-muted-foreground`}>
                      {new Date(message.created_at).toLocaleDateString(
                        undefined,
                        { day: "numeric", month: "long", year: "numeric" },
                      )}
                    </div>
                  )}
                  {email ? (
                    <EmailMessage message={message} preview={data.preview} />
                  ) : (
                    <ChatMessageBubble
                      showSentIndicator={false}
                      message={message}
                      customerName={
                        work.customer_name ||
                        work.customer_address ||
                        "Customer"
                      }
                    />
                  )}
                </div>
              ))}
              {email&&data.drafts?.map(draft=><EmailMessage key={draft.id} message={draft} preview={data.preview}/>)}
            </div>
          </div>
          {newMessages > 0 && (
            <Button
              className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-xl"
              size="sm"
              onClick={scrollEnd}
            >
              <ArrowDown className="mr-2 size-4" />
              {newMessages} new messages
            </Button>
          )}
        </section>
        <aside
          className={`${contextOpen ? "absolute inset-x-0 bottom-10 top-28 z-20 block" : "hidden"} space-y-6 overflow-y-auto border-l bg-card p-5 lg:static lg:block`}
        >
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[.16em] text-muted-foreground">
              Interaction context
            </p>
            <div className="flex items-center gap-2 text-sm font-medium">
              <UserRound className="size-4 text-muted-foreground" />
              {work.customer_name || "Customer"}
            </div>
            <p className="mt-2 break-all text-xs text-muted-foreground">
              {work.customer_address || "Address unavailable"}
            </p>
          </div>
          <dl className="space-y-4 text-xs">
            {[
              [
                "Agent",
                [work.first_name, work.last_name].filter(Boolean).join(" ") ||
                  work.agent_username ||
                  "Unassigned",
              ],
              [
                "Queue",
                work.queue_display_name || work.queue_name || "No queue",
              ],
              ["Direction", work.direction],
              ["Priority", work.priority ?? "—"],
              ["Started", date(work.created_at)],
              [
                "Closed",
                work.terminal_at ? date(work.terminal_at) : "In progress",
              ],
              ...(data.mailbox ? [["Mailbox", data.mailbox.address]] : []),
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {data.episodes.length > 1 && (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-xs font-semibold">
                <Clock3 className="size-3" />
                Conversation episodes
              </p>
              <p className="text-[11px] text-muted-foreground">
                Each episode has its own historical record.
              </p>
              {data.episodes.map((episode) => (
                <button
                  type="button"
                  key={episode.id}
                  disabled={episode.id === work.id || !onSelectEpisode}
                  onClick={() => onSelectEpisode?.(episode.id)}
                  className={`block w-full rounded-lg border p-2 text-left text-[11px] ${episode.id === work.id ? "border-emerald-500/40 bg-emerald-500/5" : "hover:bg-muted"}`}
                >
                  {date(episode.created_at)}
                  <span className="mt-1 block text-muted-foreground">
                    {episode.id === work.id ? "Selected · " : ""}
                    {episode.state}
                  </span>
                </button>
              ))}
            </div>
          )}
          {!!data.journey?.length && (
            <div className="space-y-2">
              <p className="text-xs font-semibold">Interaction journey</p>
              {data.journey.map((segment) => (
                <div
                  key={segment.id}
                  className="border-l-2 border-muted pl-3 text-[11px]"
                >
                  <p className="font-medium">
                    {segment.agent_username ||
                      segment.queue_name ||
                      segment.kind}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {segment.outcome || segment.kind} ·{" "}
                    {date(segment.started_at)}
                  </p>
                  {segment.wrapup_code_id && (
                    <p className="mt-1">
                      Disposition:{" "}
                      {segment.wrapup_code_name || segment.wrapup_code_id}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          <details className="text-[10px] text-muted-foreground">
            <summary className="cursor-pointer">Identifiers</summary>
            <p className="mt-2 break-all">Interaction: {work.id}</p>
            <p className="mt-2 break-all">
              Conversation: {work.conversation_id}
            </p>
          </details>
        </aside>
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t bg-card px-3 py-2 text-[11px] text-muted-foreground">
        <LockKeyhole className="size-3" />
        Observation only. Messages{email?', saved agent drafts':''} and delivery evidence refresh automatically.
      </footer>
    </div>
  );
}
export default function ConversationPreview({
  open,
  onOpenChange,
  interaction,
}) {
  const initialId =
    interaction?.workItemId || interaction?.work_item_id || interaction?.id;
  const [selection, setSelection] = useState(null);
  const episodeId =
    selection && selection.initialId === initialId ? selection.id : initialId;
  const setEpisodeId = (id) => setSelection({ initialId, id });
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) setSelection(null);
        onOpenChange(value);
      }}
    >
      <DialogContent className="flex h-[min(88dvh,900px)] w-[96vw] max-w-[1180px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1180px]">
        <DialogTitle className="sr-only">Conversation preview</DialogTitle>
        <DialogDescription className="sr-only">
          Read-only conversation and interaction context with live updates.
        </DialogDescription>
        {open && episodeId && (
          <ConversationReader
            key={episodeId}
            workItemId={episodeId}
            onSelectEpisode={setEpisodeId}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
