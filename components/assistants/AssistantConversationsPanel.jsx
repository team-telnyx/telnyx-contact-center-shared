"use client";

import { useCallback, useEffect, useState } from "react";
import {
  IconActivity,
  IconChevronLeft,
  IconChevronRight,
  IconEye,
  IconMessage2,
  IconPhone,
  IconPlayerPlay,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import AssistantCallSessionSheet from "@/components/assistants/AssistantCallSessionSheet";
import ConversationMessagesSheet from "@/components/assistants/ConversationMessagesSheet";
import RecordingPlayer from "@/components/contact-center/RecordingPlayer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function channelFor(conversation) {
  const channel = conversation?.metadata?.telnyx_conversation_channel || conversation?.metadata?.channel || conversation?.channel || "chat";
  return String(channel).toLowerCase().includes("phone") || String(channel).toLowerCase().includes("voice") ? "Call" : "Chat";
}

function findNestedValue(input, keys, seen = new Set()) {
  if (!input || typeof input !== "object" || seen.has(input)) return "";
  seen.add(input);
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  for (const value of Object.values(input)) {
    const found = findNestedValue(value, keys, seen);
    if (found) return found;
  }
  return "";
}

async function identifiersFor(conversation) {
  const metadata = conversation?.metadata || {};
  const found = {
    callSessionId: metadata.call_session_id || metadata.telnyx_call_session_id || "",
    callControlId: metadata.call_control_id || "",
  };
  if (found.callSessionId && found.callControlId) return found;
  try {
    const response = await fetch(`/api/ai/conversations/${encodeURIComponent(conversation.id)}/webhook-logs?page[size]=50`, { cache: "no-store" });
    const data = await response.json();
    const logs = data?.data?.data || data?.data || [];
    found.callSessionId ||= findNestedValue(logs, ["call_session_id", "telnyx_call_session_id"]);
    found.callControlId ||= findNestedValue(logs, ["ai_call_control_id", "call_control_id"]);
  } catch {}
  return found;
}

export default function AssistantConversationsPanel({ assistantId }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(Boolean(assistantId));
  const [recordings, setRecordings] = useState({});
  const [recordingPanel, setRecordingPanel] = useState(null);
  const [sessionPanel, setSessionPanel] = useState(null);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const load = useCallback(async () => {
    if (!assistantId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), "metadata->assistant_id": assistantId });
      const response = await fetch(`/api/ai/conversations?${params.toString()}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Failed to load conversations");
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(Number(data.total || 0));
    } catch {
      setItems([]);
      setTotal(0);
    } finally { setLoading(false); }
  }, [assistantId, page, pageSize]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [assistantId]);

  useEffect(() => {
    let cancelled = false;
    const calls = items.filter((conversation) => channelFor(conversation) === "Call");
    Promise.all(calls.map(async (conversation) => {
      const { callSessionId } = await identifiersFor(conversation);
      if (!callSessionId) return [conversation.id, null];
      try {
        const response = await fetch(`/api/voice/recordings?call_session_id=${encodeURIComponent(callSessionId)}`, { cache: "no-store" });
        const data = await response.json();
        return [conversation.id, data?.ok && data.data?.length ? data.data[0] : null];
      } catch { return [conversation.id, null]; }
    })).then((entries) => { if (!cancelled) setRecordings(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [items]);

  async function openVoiceSession(conversation) {
    const ids = await identifiersFor(conversation);
    if (!ids.callSessionId) return notify({ title: "No Voice API session found", variant: "warning" });
    setSessionPanel({ id: ids.callSessionId, call_control_id: ids.callControlId, product: "call_control" });
  }

  async function openTexmlSession(conversation) {
    const ids = await identifiersFor(conversation);
    if (!ids.callControlId) return notify({ title: "No TeXML session found", variant: "warning" });
    setSessionPanel({ id: ids.callControlId, call_control_id: ids.callControlId, product: "texml" });
  }

  if (!assistantId) return <Card className="flex h-full items-center justify-center"><p className="text-sm text-muted-foreground">Save the assistant to view conversations.</p></Card>;

  return (
    <>
      <Card className="flex h-full min-h-0 flex-col overflow-hidden">
        <CardHeader className="shrink-0 border-b pb-4">
          <div className="flex items-center justify-between">
            <div><CardTitle>Conversations</CardTitle><CardDescription>Conversation history, transcripts, recordings, and call session details.</CardDescription></div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}><IconRefresh className={loading ? "size-4 animate-spin" : "size-4"} />Refresh</Button>
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card"><TableRow><TableHead className="w-[28%]">ID</TableHead><TableHead>Name</TableHead><TableHead>Channel</TableHead><TableHead>User</TableHead><TableHead>Created</TableHead><TableHead className="w-40 text-right">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {loading ? Array.from({ length: 6 }, (_, index) => <TableRow key={index}>{Array.from({ length: 6 }, (__, cell) => <TableCell key={cell}><Skeleton className="h-5 w-full" /></TableCell>)}</TableRow>) : items.map((conversation) => {
                  const channel = channelFor(conversation);
                  const recording = recordings[conversation.id];
                  return (
                    <TableRow key={conversation.id}>
                      <TableCell className="max-w-0 truncate font-mono text-xs" title={conversation.id}>{conversation.id}</TableCell>
                      <TableCell className="max-w-0"><span className="flex items-center gap-2 truncate"><IconMessage2 className="size-4 shrink-0 text-emerald-500" /><span className="truncate">{conversation.name || "<no name>"}</span></span></TableCell>
                      <TableCell><Badge className={channel === "Call" ? "bg-emerald-600 text-white" : "bg-sky-600 text-white"}>{channel}</Badge></TableCell>
                      <TableCell className="max-w-0 truncate">{conversation.metadata?.telnyx_end_user_target || conversation.metadata?.end_user_target || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{formatDate(conversation.created_at)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          {recording ? <Button variant="ghost" size="icon" title="Play recording" onClick={() => setRecordingPanel({ conversation, recording })}><IconPlayerPlay className="size-4 text-orange-500" /></Button> : null}
                          {channel === "Call" ? <Button variant="ghost" size="icon" title="View Voice API session details" onClick={() => openVoiceSession(conversation)}><IconPhone className="size-4 text-emerald-500" /></Button> : null}
                          {channel === "Call" ? <Button variant="ghost" size="icon" title="View TeXML session details" onClick={() => openTexmlSession(conversation)}><IconActivity className="size-4 text-blue-500" /></Button> : null}
                          <ConversationMessagesSheet conversation={conversation}><Button variant="ghost" size="icon" title="Preview messages"><IconEye className="size-4 text-emerald-500" /></Button></ConversationMessagesSheet>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && !items.length ? <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No conversations found.</TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </div>
          <div className="flex shrink-0 items-center justify-between border-t px-4 py-3"><span className="text-xs text-muted-foreground">Total: {total}</span><div className="flex items-center gap-3"><Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}><SelectTrigger className="h-8 w-20"><SelectValue /></SelectTrigger><SelectContent>{[10, 25, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent></Select><span className="text-sm">Page {page} of {totalPages}</span><Button variant="outline" size="icon" className="size-8" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}><IconChevronLeft className="size-4" /></Button><Button variant="outline" size="icon" className="size-8" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages}><IconChevronRight className="size-4" /></Button></div></div>
        </CardContent>
      </Card>

      {sessionPanel ? <AssistantCallSessionSheet session={sessionPanel} onClose={() => setSessionPanel(null)} /> : null}
      {recordingPanel ? <div className="fixed inset-x-0 bottom-0 z-[110] w-screen border-t bg-background p-4 shadow-2xl"><div className="w-full"><div className="mb-3 flex items-center justify-between"><div><p className="text-sm font-semibold">Conversation Recording</p><p className="text-xs text-muted-foreground">{recordingPanel.conversation.name || recordingPanel.conversation.id}</p></div><Button variant="ghost" size="icon" onClick={() => setRecordingPanel(null)}><IconX className="size-4" /></Button></div><RecordingPlayer recordingId={recordingPanel.recording.id || recordingPanel.recording.recording_id} src={recordingPanel.recording.recording_url} format={recordingPanel.recording.format} channels={recordingPanel.recording.channels} /></div></div> : null}
    </>
  );
}
