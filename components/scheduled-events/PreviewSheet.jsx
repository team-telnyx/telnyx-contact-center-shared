"use client";

import React, { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconEye, IconCalendar, IconClock, IconCheck, IconX, IconAlertCircle, IconCopy, IconRobot } from "@tabler/icons-react";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Preview sheet component for Scheduled Events
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {object} props.event - Event to preview
 * @param {function} props.onOpenConversation - Optional callback to open AI conversation sheet
 */
export default function PreviewSheet({ open, onOpenChange, event, onOpenConversation }) {
  const [fullEvent, setFullEvent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copiedField, setCopiedField] = useState(null);

  async function handleCopy(text, field) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }

  useEffect(() => {
    async function loadFullEvent() {
      if (!open || !event) {
        setFullEvent(null);
        return;
      }

      const eventId = event.scheduled_event_id || event.id;
      const assistantId = event.assistant_id;

      if (!eventId || !assistantId) {
        // Use the event data we already have
        setFullEvent(event);
        return;
      }

      setLoading(true);
      try {
        const res = await fetch(
          `/api/admin/scheduled-events/${encodeURIComponent(
            eventId
          )}?assistantId=${encodeURIComponent(assistantId)}`,
          { cache: "no-store" }
        );
        if (res.ok) {
          const responseData = await res.json();
          // Telnyx API returns { data: {...} } structure, but our API might return it directly
          const eventData = responseData?.data || responseData;
          // Merge with existing event data to preserve assistant_name if present
          setFullEvent({ ...event, ...eventData });
        } else {
          // Fallback to event data we have
          setFullEvent(event);
        }
      } catch (err) {
        console.error("Failed to load full event:", err);
        // Fallback to event data we have
        setFullEvent(event);
      } finally {
        setLoading(false);
      }
    }

    loadFullEvent();
  }, [open, event]);

  const displayEvent = fullEvent || event;
  if (!displayEvent) return null;

  function formatDateTime(dateStr) {
    if (!dateStr) return "—";
    try {
      const date = new Date(dateStr);
      return date.toLocaleString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });
    } catch {
      return dateStr;
    }
  }

  function channelBadgeColor(channel) {
    switch (channel) {
      case "phone_call":
        return "text-telnyx-green border-telnyx-green";
      case "sms_chat":
      case "sms":
        return "text-orange-500 border-orange-500";
      default:
        return "text-gray-500 border-gray-300";
    }
  }

  function formatChannelName(channel) {
    switch (channel) {
      case "phone_call":
        return "PHONE CALL";
      case "sms_chat":
      case "sms":
        return "SMS";
      default:
        return String(channel || "—").toUpperCase();
    }
  }

  function formatCallDuration(seconds) {
    if (!seconds && seconds !== 0) return null;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function getStatusBadge(status) {
    switch (String(status || "").toLowerCase()) {
      case "completed":
        return (
          <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-300">
            <IconCheck className="size-3 mr-1" /> Completed
          </Badge>
        );
      case "pending":
        return (
          <Badge className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-300">
            <IconClock className="size-3 mr-1" /> Pending
          </Badge>
        );
      case "in_progress":
        return (
          <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-blue-300">
            <IconClock className="size-3 mr-1" /> In Progress
          </Badge>
        );
      case "failed":
        return (
          <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-300">
            <IconX className="size-3 mr-1" /> Failed
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-xs">
            {String(status || "—").toUpperCase()}
          </Badge>
        );
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconEye className="size-5" />
            Scheduled Event Details
          </SheetTitle>
        </SheetHeader>

        {/* Fixed Metadata Section */}
        <div className="px-6 py-3 border-b bg-muted/30 space-y-3">
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <div className="font-semibold text-muted-foreground uppercase mb-1">
                Channel
              </div>
              <Badge
                variant="outline"
                className={`text-xs ${channelBadgeColor(
                  displayEvent.telnyx_conversation_channel
                )}`}
              >
                {formatChannelName(displayEvent.telnyx_conversation_channel)}
              </Badge>
            </div>
            <div>
              <div className="font-semibold text-muted-foreground uppercase mb-1">
                Status
              </div>
              {loading ? (
                <Skeleton className="h-5 w-20" />
              ) : (
                getStatusBadge(displayEvent.status)
              )}
            </div>
            <div>
              <div className="font-semibold text-muted-foreground uppercase mb-1">
                Duration
              </div>
              {displayEvent.call_duration !== null && displayEvent.call_duration !== undefined ? (
                <Badge variant="outline" className="text-xs text-orange-600 border-orange-500 bg-orange-50 dark:bg-orange-900/20 dark:text-orange-400 font-mono">
                  {formatCallDuration(displayEvent.call_duration)}
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </div>
          </div>
          
          {/* AI Assistant Name and ID */}
          {displayEvent.assistant_name && (
            <div className="text-xs">
              <div className="font-semibold text-muted-foreground uppercase mb-1">
                AI Assistant
              </div>
              <div className="text-sm font-medium mb-1">
                {displayEvent.assistant_name}
              </div>
              {displayEvent.assistant_id && (
                <div className="flex items-center gap-2">
                  <div className="text-xs font-mono truncate flex-1">
                    {displayEvent.assistant_id}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={`h-6 w-6 ${
                      copiedField === "assistant_id" ? "text-telnyx-green" : ""
                    }`}
                    onClick={() =>
                      handleCopy(displayEvent.assistant_id, "assistant_id")
                    }
                    title={
                      copiedField === "assistant_id" ? "Copied" : "Copy Assistant ID"
                    }
                  >
                    {copiedField === "assistant_id" ? (
                      <IconCheck className="size-3 text-telnyx-green" />
                    ) : (
                      <IconCopy className="size-3" />
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
          
          {/* Event ID */}
          <div className="text-xs">
            <div className="font-semibold text-muted-foreground uppercase mb-1">
              Event ID
            </div>
            <div className="flex items-center gap-2">
              <div className="text-xs font-mono truncate flex-1">
                {displayEvent.scheduled_event_id || displayEvent.id || "—"}
              </div>
              {(displayEvent.scheduled_event_id || displayEvent.id) && (
                <Button
                  size="icon"
                  variant="ghost"
                  className={`h-6 w-6 ${
                    copiedField === "event_id" ? "text-telnyx-green" : ""
                  }`}
                  onClick={() =>
                    handleCopy(
                      displayEvent.scheduled_event_id || displayEvent.id,
                      "event_id"
                    )
                  }
                  title={copiedField === "event_id" ? "Copied" : "Copy Event ID"}
                >
                  {copiedField === "event_id" ? (
                    <IconCheck className="size-3 text-telnyx-green" />
                  ) : (
                    <IconCopy className="size-3" />
                  )}
                </Button>
              )}
            </div>
          </div>
          
          {/* Conversation ID */}
          {displayEvent.conversation_id && (
            <div className="text-xs">
              <div className="font-semibold text-muted-foreground uppercase mb-1">
                Conversation ID
              </div>
              <div className="flex items-center gap-2">
                <div className="text-xs font-mono truncate flex-1">
                  {displayEvent.conversation_id}
                </div>
                {onOpenConversation && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-blue-500 hover:text-blue-600"
                    onClick={() => {
                      onOpenConversation(displayEvent.conversation_id);
                      onOpenChange(false); // Close preview sheet when opening conversation
                    }}
                    title="View AI conversation with recording"
                  >
                    <IconRobot className="size-3" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className={`h-6 w-6 ${
                    copiedField === "conversation_id" ? "text-telnyx-green" : ""
                  }`}
                  onClick={() =>
                    handleCopy(displayEvent.conversation_id, "conversation_id")
                  }
                  title={
                    copiedField === "conversation_id"
                      ? "Copied"
                      : "Copy Conversation ID"
                  }
                >
                  {copiedField === "conversation_id" ? (
                    <IconCheck className="size-3 text-telnyx-green" />
                  ) : (
                    <IconCopy className="size-3" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <>

              {/* Scheduled Date/Time */}
              <div className="space-y-2">
                <Label className="text-sm font-semibold text-muted-foreground uppercase">
                  Scheduled Date & Time
                </Label>
                <div className="text-sm flex items-center gap-2">
                  <IconCalendar className="size-4 text-telnyx-green" />
                  {formatDateTime(displayEvent.scheduled_at_fixed_datetime)}
                </div>
              </div>

              {/* Created At */}
              {displayEvent.created_at && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-muted-foreground uppercase">
                    Created At
                  </Label>
                  <div className="text-sm flex items-center gap-2">
                    <IconClock className="size-4 text-muted-foreground" />
                    {formatDateTime(displayEvent.created_at)}
                  </div>
                </div>
              )}

              {/* Phone Numbers */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-muted-foreground uppercase">
                    From Number
                  </Label>
                  <div className="text-sm font-mono">
                    {displayEvent.telnyx_agent_target || "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Agent phone number
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-muted-foreground uppercase">
                    To Number
                  </Label>
                  <div className="text-sm font-mono">
                    {displayEvent.telnyx_end_user_target || "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Recipient phone number
                  </div>
                </div>
              </div>

              {/* Retry Information */}
              {(displayEvent.retry_count !== undefined ||
                displayEvent.retry_attempts !== undefined) && (
                <div className="grid grid-cols-2 gap-4">
                  {displayEvent.retry_count !== undefined && (
                    <div className="space-y-2">
                      <Label className="text-sm font-semibold text-muted-foreground uppercase">
                        Retry Count
                      </Label>
                      <div className="text-sm">
                        {displayEvent.retry_count}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Number of retries attempted
                      </div>
                    </div>
                  )}
                  {displayEvent.retry_attempts !== undefined && (
                    <div className="space-y-2">
                      <Label className="text-sm font-semibold text-muted-foreground uppercase">
                        Retry Attempts
                      </Label>
                      <div className="text-sm">
                        {displayEvent.retry_attempts}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Maximum retry attempts
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* SMS Text (if applicable) */}
              {(displayEvent.telnyx_conversation_channel === "sms_chat" ||
                displayEvent.telnyx_conversation_channel === "sms") &&
                displayEvent.text && (
                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-muted-foreground uppercase">
                      SMS Message Text
                    </Label>
                    <div className="p-3 bg-muted/50 rounded-md text-sm border">
                      {displayEvent.text}
                    </div>
                  </div>
                )}

              {/* Conversation Metadata */}
              {displayEvent.conversation_metadata &&
                Object.keys(displayEvent.conversation_metadata).length > 0 && (
                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-muted-foreground uppercase">
                      Conversation Metadata
                    </Label>
                    <div className="p-3 bg-muted/50 rounded-md text-xs border font-mono overflow-x-auto">
                      <pre className="whitespace-pre-wrap break-words">
                        {JSON.stringify(displayEvent.conversation_metadata, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}

              {/* Errors */}
              {displayEvent.errors &&
                Array.isArray(displayEvent.errors) &&
                displayEvent.errors.length > 0 && (
                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-red-600 uppercase flex items-center gap-2">
                      <IconAlertCircle className="size-4" />
                      Errors
                    </Label>
                    <div className="space-y-2">
                      {displayEvent.errors.map((error, idx) => (
                        <div
                          key={idx}
                          className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300"
                        >
                          {error}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </>
          )}
        </div>

        {/* Fixed Footer */}
        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

