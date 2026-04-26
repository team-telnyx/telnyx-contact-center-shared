"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { IconActivity, IconX, IconCopy, IconCheck } from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import AiConversationCostsTab from "@/components/contact-center/AiConversationCostsTab";
import { toast } from "sonner";
import { Tool, ToolContent } from "@/components/ai-elements/tool";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDownIcon } from "lucide-react";
import {
  IconPhone,
  IconPhoneIncoming,
  IconPhoneOff,
  IconLink,
  IconPlayerPlay,
  IconFileText,
  IconRobot,
} from "@tabler/icons-react";

const getWebhookIcon = (eventType) => {
  const type = String(eventType || "").toLowerCase();

  if (type.includes("initiated") || type.includes("ringing")) {
    return <IconPhoneIncoming className="size-4 text-blue-500" />;
  }
  if (type.includes("answered")) {
    return <IconPhone className="size-4 text-green-500" />;
  }
  if (type.includes("hangup")) {
    return <IconPhoneOff className="size-4 text-red-500" />;
  }
  if (type.includes("bridged")) {
    return <IconLink className="size-4 text-indigo-500" />;
  }
  if (type.includes("playback") || type.includes("speak")) {
    return <IconPlayerPlay className="size-4 text-purple-500" />;
  }
  if (type.includes("gather") || type.includes("dtmf")) {
    return <IconFileText className="size-4 text-cyan-500" />;
  }
  if (type.includes("conversation") || type.includes("assistant")) {
    return <IconRobot className="size-4 text-violet-500" />;
  }

  return <IconActivity className="size-4 text-muted-foreground" />;
};

function CallEventToolHeader({ eventName, eventType, timestamp, failed }) {
  const Icon = getWebhookIcon(eventName);

  const formatTimestamp = (ts) => {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
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
      return String(ts);
    }
  };

  return (
    <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3 hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {Icon}
        <span className="font-medium text-sm truncate">{eventName}</span>
        <Badge
          variant={eventType === "webhook" ? "default" : "secondary"}
          className="text-xs"
        >
          {eventType}
        </Badge>
        {failed && (
          <Badge variant="destructive" className="text-xs">
            Failed
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
          {formatTimestamp(timestamp)}
        </span>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </div>
    </CollapsibleTrigger>
  );
}

const formatDate = (dt) => {
  if (!dt) return "";
  try {
    const d = new Date(dt);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch {
    return dt || "";
  }
};

export default function InteractionDetailsSheet({
  open,
  onOpenChange,
  interaction,
}) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [copiedField, setCopiedField] = useState(null);
  const [eventsMessage, setEventsMessage] = useState("");
  const [sessionWithCallControlId, setSessionWithCallControlId] =
    useState(null);

  const session = useMemo(() => {
    if (!interaction) return null;
    return {
      id: interaction.call_session_id || interaction.call_control_id || "",
      call_control_id: interaction.call_control_id || null,
      connection_id: null,
      from: interaction.from_number || "",
      to: interaction.to_number || "",
      started_at:
        interaction.answered_at ||
        interaction.assigned_at ||
        interaction.enqueued_at ||
        interaction.created_at ||
        null,
    };
  }, [interaction]);

  useEffect(() => {
    if (!open || !session) return;

    const fetchEvents = async () => {
      if (!interaction?.call_session_id) {
        setEvents([]);
        setEventsMessage("Cannot fetch call events: missing call session ID.");
        return;
      }
      setLoading(true);
      setEvents([]);
      setEventsMessage("");

      try {
        const params = new URLSearchParams();
        params.set("page[number]", "1");
        params.set("page[size]", "100");
        params.set(
          "filter[application_session_id]",
          interaction.call_session_id
        );

        const response = await fetch(
          `/api/voice/call-history/events?${params.toString()}`
        );
        const data = await response.json();

        if (data.ok) {
          const fetchedEvents = data.data || [];
          setEvents(fetchedEvents);

          const firstEvent = fetchedEvents[0];
          const payload =
            firstEvent?.payload?.payload || firstEvent?.payload || {};

          let updatedSession = { ...session };

          if (payload.call_control_id) {
            updatedSession.call_control_id = payload.call_control_id;
          }
          if (payload.connection_id) {
            updatedSession.connection_id = payload.connection_id;
          }
          if (payload.from) {
            updatedSession.from = payload.from;
          }
          if (payload.to) {
            updatedSession.to = payload.to;
          }
          if (payload.start_time) {
            updatedSession.started_at = payload.start_time;
          } else if (firstEvent?.occurred_at) {
            updatedSession.started_at = firstEvent.occurred_at;
          }
          if (payload.call_session_id) {
            updatedSession.call_session_id = payload.call_session_id;
          }

          setSessionWithCallControlId(updatedSession);
        } else {
          toast.error(data.error || "Failed to load call events");
          setEventsMessage("Failed to load call events.");
        }
      } catch (error) {
        console.error("Error fetching call events:", error);
        toast.error("Failed to load call events");
        setEventsMessage("Failed to load call events.");
      } finally {
        setLoading(false);
      }
    };

    fetchEvents();
  }, [open, session]);

  const handleCopy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(label);
      toast.success(`${label} copied to clipboard`);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      toast.error("Failed to copy to clipboard");
    }
  };

  if (!open || !session) return null;

  const sessionData = sessionWithCallControlId || session;

  return (
    <div className="fixed inset-y-0 right-0 w-2xl bg-background dark:bg-zinc-900 border-l shadow-2xl z-50 flex flex-col animate-in slide-in-from-right">
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconActivity className="h-5 w-5 text-telnyx-green" />
            <h2 className="font-semibold text-lg">Call Session Details</h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
          >
            <IconX className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="p-4 pb-0">
        <Card className="bg-muted/50">
          <CardContent className="space-y-2 text-sm py-0">
            {sessionData.call_control_id && (
              <div className="grid grid-cols-[110px_1fr] gap-1">
                <span className="text-muted-foreground">Call Control ID:</span>
                <div className="flex items-center gap-2">
                  <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all flex-1">
                    {sessionData.call_control_id}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() =>
                      handleCopy(sessionData.call_control_id, "Call Control ID")
                    }
                  >
                    {copiedField === "Call Control ID" ? (
                      <IconCheck className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <IconCopy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            )}
            <div className="grid grid-cols-[110px_1fr] gap-2">
              <span className="text-muted-foreground">Session ID:</span>
              <div className="flex items-center gap-2">
                <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all flex-1">
                  {sessionData.id}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => handleCopy(sessionData.id, "Session ID")}
                >
                  {copiedField === "Session ID" ? (
                    <IconCheck className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <IconCopy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
            {sessionData.connection_id && (
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-muted-foreground">Connection ID:</span>
                <div className="flex items-center gap-2">
                  <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all flex-1">
                    {sessionData.connection_id}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() =>
                      handleCopy(sessionData.connection_id, "Connection ID")
                    }
                  >
                    {copiedField === "Connection ID" ? (
                      <IconCheck className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <IconCopy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            )}
            {sessionData.from && (
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-muted-foreground">From:</span>
                <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                  {sessionData.from}
                </code>
              </div>
            )}
            {sessionData.to && (
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-muted-foreground">To:</span>
                <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                  {sessionData.to}
                </code>
              </div>
            )}
            {sessionData.started_at && (
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-muted-foreground">Started At:</span>
                <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                  {formatDate(sessionData.started_at)}
                </code>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="events" className="flex-1 min-h-0 flex flex-col">
        <div className="px-4 pt-4 pb-2">
          <TabsList>
            <TabsTrigger value="events" className="flex items-center gap-1.5">
              Call Events
              <Badge variant="outline" className="text-xs ml-1">{events.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="costs">Costs</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="costs" className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          <AiConversationCostsTab conversation={interaction} />
        </TabsContent>

        <TabsContent value="events" className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, idx) => (
              <Skeleton key={idx} className="h-20 w-full" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <IconActivity className="h-12 w-12 mb-4 opacity-50" />
            <p className="text-sm">
              {eventsMessage || "No events found for this session"}
            </p>
            {!eventsMessage && (
              <p className="text-xs mt-1">
                Events will appear here when available
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {events.map((event, idx) => (
              <Tool key={event.id || idx} defaultOpen={false}>
                <CallEventToolHeader
                  eventName={event.name || event.event_type || "call.event"}
                  eventType={event.type || "webhook"}
                  timestamp={event.occurred_at || event.event_timestamp}
                  failed={event.failed}
                />
                <ToolContent>
                  <CodeBlock
                    code={JSON.stringify(
                      event.payload || event.metadata || event,
                      null,
                      2
                    )}
                    language="json"
                  >
                    <CodeBlockCopyButton />
                  </CodeBlock>
                </ToolContent>
              </Tool>
            ))}
          </div>
        )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
