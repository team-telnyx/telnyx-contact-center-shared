"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { IconActivity, IconX, IconCopy, IconCheck } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Tool, ToolContent } from "@/components/ai-elements/tool";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AiConversationCostsTab from "@/components/contact-center/AiConversationCostsTab";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDownIcon } from "lucide-react";
import {
  IconPhone,
  IconPhoneIncoming,
  IconPhoneOutgoing,
  IconPhoneOff,
  IconLink,
  IconPlayerPlay,
  IconFileText,
  IconRobot,
} from "@tabler/icons-react";

// Get icon for webhook event type
const getWebhookIcon = (eventType) => {
  const type = String(eventType || "").toLowerCase();

  if (type.includes("initiated") || type.includes("ringing")) {
    return <IconPhoneIncoming className="size-4 text-blue-500" />;
  }
  if (type.includes("answered")) {
    return <IconPhone className="size-4 text-green-500" />;
  }
  if (type.includes("hangup") || type.includes("hangup")) {
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

// Custom ToolHeader for call events
function CallEventToolHeader({ eventName, eventType, timestamp, failed }) {
  const Icon = getWebhookIcon(eventName);

  // Format timestamp with milliseconds - converts UTC to local timezone
  const formatTimestamp = (ts) => {
    if (!ts) return "";
    try {
      const d = new Date(ts); // Parses UTC timestamp
      if (isNaN(d.getTime())) return String(ts);
      const pad2 = (n) => String(n).padStart(2, "0");
      const pad3 = (n) => String(n).padStart(3, "0");
      // These methods return local timezone values
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

// Get product badge
const getProductBadge = (product) => {
  if (!product) return <Badge variant="outline">Unknown</Badge>;

  const productMap = {
    call_control: { label: "Call Control", variant: "default" },
    texml: { label: "TeXML", variant: "secondary" },
    conference: { label: "Conference", variant: "secondary" },
    programmable_voice: { label: "Programmable Voice", variant: "outline" },
  };

  const config = productMap[product] || {
    label: product,
    variant: "outline",
  };

  return <Badge variant={config.variant}>{config.label}</Badge>;
};

// Format date
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

/**
 * CallSessionDetailsSheet
 * Displays call session details and events in a side panel
 * @param {Object} session - The session object with id, from, to, etc.
 * @param {Function} onClose - Callback when closing the panel
 */
export default function AssistantCallSessionSheet({ session, onClose }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [copiedField, setCopiedField] = useState(null);
  const [sessionWithCallControlId, setSessionWithCallControlId] =
    useState(session);

  // Fetch call events
  useEffect(() => {
    if (!session) return;

    const fetchEvents = async () => {
      setLoading(true);
      setEvents([]);

      try {
        const params = new URLSearchParams();
        params.set("page[number]", "1");
        params.set("page[size]", "100");
        params.set("filter[application_session_id]", session.id);

        const response = await fetch(
          `/api/voice/call-history/events?${params.toString()}`
        );
        const data = await response.json();

        if (data.ok) {
          const fetchedEvents = data.data || [];
          setEvents(fetchedEvents);

          // Extract session details from the first event
          const firstEvent = fetchedEvents[0];
          const payload = firstEvent?.payload?.payload || {};

          let updatedSession = { ...session };

          // Extract call_control_id
          if (payload.call_control_id) {
            updatedSession.call_control_id = payload.call_control_id;
          }

          // Extract connection_id
          if (payload.connection_id) {
            updatedSession.connection_id = payload.connection_id;
          }

          // Extract from
          if (payload.from) {
            updatedSession.from = payload.from;
          }

          // Extract to
          if (payload.to) {
            updatedSession.to = payload.to;
          }

          // Extract started_at (prefer start_time from payload, fallback to occurred_at)
          if (payload.start_time) {
            updatedSession.started_at = payload.start_time;
          } else if (firstEvent?.payload?.occurred_at) {
            updatedSession.started_at = firstEvent.payload.occurred_at;
          }

          // Extract call_session_id
          if (payload.call_session_id) {
            updatedSession.call_session_id = payload.call_session_id;
          }

          // Determine product type based on session ID format
          // UUID format = call_control, v3: format = texml
          if (session.id && !session.id.startsWith("v3:")) {
            updatedSession.product = "call_control";
          } else if (session.id && session.id.startsWith("v3:")) {
            updatedSession.product = "texml";
          }

          setSessionWithCallControlId(updatedSession);
        } else {
          notify({ title: data.error || "Failed to load call events", variant: "error" });
        }
      } catch (error) {
        console.error("Error fetching call events:", error);
        notify({ title: "Failed to load call events", variant: "error" });
      } finally {
        setLoading(false);
      }
    };

    fetchEvents();
  }, [session]);

  // Handle copy to clipboard
  const handleCopy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(label);
      notify({ title: `${label} copied to clipboard`, variant: "success" });
      setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      notify({ title: "Failed to copy to clipboard", variant: "error" });
    }
  };

  if (!session) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-[42rem] bg-background border-l shadow-2xl z-50 flex flex-col animate-in slide-in-from-right">
      {/* Panel Header */}
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconActivity className="h-5 w-5 text-telnyx-green" />
            <h2 className="font-semibold text-lg">Call Session Details</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <IconX className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Session Info - Static */}
      <div className="p-4 pb-0">
        <Card className="bg-muted/50">
          <CardContent className="space-y-2 text-sm py-0">
            {sessionWithCallControlId.call_control_id && (
              <div className="grid grid-cols-[110px_1fr] gap-1">
                <span className="text-muted-foreground">Call Control ID:</span>
                <div className="flex items-center gap-2">
                  <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all flex-1">
                    {sessionWithCallControlId.call_control_id}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 flex-shrink-0"
                    onClick={() =>
                      handleCopy(
                        sessionWithCallControlId.call_control_id,
                        "Call Control ID"
                      )
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
                  {sessionWithCallControlId.id}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex-shrink-0"
                  onClick={() =>
                    handleCopy(sessionWithCallControlId.id, "Session ID")
                  }
                >
                  {copiedField === "Session ID" ? (
                    <IconCheck className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <IconCopy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
            {sessionWithCallControlId.connection_id && (
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-muted-foreground">Connection ID:</span>
                <div className="flex items-center gap-2">
                  <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all flex-1">
                    {sessionWithCallControlId.connection_id}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 flex-shrink-0"
                    onClick={() =>
                      handleCopy(
                        sessionWithCallControlId.connection_id,
                        "Connection ID"
                      )
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
            {sessionWithCallControlId.from && (
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-muted-foreground">From:</span>
                <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                  {sessionWithCallControlId.from}
                </code>
              </div>
            )}
            {sessionWithCallControlId.to && (
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-muted-foreground">To:</span>
                <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                  {sessionWithCallControlId.to}
                </code>
              </div>
            )}
            {sessionWithCallControlId.started_at && (
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-muted-foreground">Started At:</span>
                <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                  {formatDate(sessionWithCallControlId.started_at)}
                </code>
              </div>
            )}
            {sessionWithCallControlId.product && (
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-muted-foreground">Product:</span>
                <div>{getProductBadge(sessionWithCallControlId.product)}</div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="events" className="flex flex-col flex-1 min-h-0 pt-4">
        <div className="px-4 pb-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="events">Call Events</TabsTrigger>
            <TabsTrigger value="costs">Costs</TabsTrigger>
          </TabsList>
        </div>

        {/* Call Events Tab */}
        <TabsContent value="events" className="flex-1 overflow-y-auto px-4 pb-4 m-0">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="font-semibold text-sm">Events</h3>
            <Badge variant="outline" className="text-xs">
              {events.length}
            </Badge>
          </div>

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, idx) => (
                <Skeleton key={idx} className="h-20 w-full" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <IconActivity className="h-12 w-12 mb-4 opacity-50" />
              <p className="text-sm">No events found for this session</p>
              <p className="text-xs mt-1">
                Events will appear here when available
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {events.map((event, idx) => (
                <Tool key={event.id || idx} defaultOpen={false}>
                  <CallEventToolHeader
                    eventName={event.name}
                    eventType={event.type}
                    timestamp={event.occurred_at}
                    failed={event.failed}
                  />
                  <ToolContent>
                    <CodeBlock
                      code={JSON.stringify(event.payload, null, 2)}
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

        {/* Costs Tab */}
        <TabsContent value="costs" className="flex-1 overflow-y-auto px-4 pb-4 m-0">
          <AiConversationCostsTab
            conversation={{
              id: sessionWithCallControlId.id,
              call_session_id: sessionWithCallControlId.call_session_id || sessionWithCallControlId.id,
              created_at: sessionWithCallControlId.started_at
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
