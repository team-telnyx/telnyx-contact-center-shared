"use client";

import { useState, useMemo } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ai-elements/message";
import { IconUser, IconPhone, IconFileText, IconX, IconClipboard, IconMessage } from "@tabler/icons-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SheetFooter } from "@/components/ui/sheet";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Format timestamp in seconds to MM:SS format
 */
function formatTimestamp(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "00:00";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Parse transcription text into channel messages
 * Format: "Channel 1: text\nChannel 2: text"
 */
function parseTranscription(transcriptionText, segments) {
  // If we have segments, use them instead of parsing text
  if (segments && Array.isArray(segments) && segments.length > 0) {
    let lastChannel = 1; // Track last channel to alternate if not specified
    return segments.map((segment) => {
      const segmentText = segment.text || "";
      // Try to determine channel from segment text
      const channelMatch = segmentText.match(/^Channel\s+(\d+):\s*(.+)$/i);
      if (channelMatch) {
        const channel = parseInt(channelMatch[1], 10);
        lastChannel = channel;
        return {
          channel,
          text: channelMatch[2].trim(),
          side: channel === 1 ? "left" : "right",
          start: segment.start,
          end: segment.end,
          timestamp: formatTimestamp(segment.start),
        };
      }
      // If no channel indicator, use the last known channel or alternate
      // Remove any leading "Channel X:" if present but not at start
      const cleanedText = segmentText.replace(/Channel\s+\d+:\s*/gi, "").trim();
      return {
        channel: lastChannel,
        text: cleanedText || segmentText,
        side: lastChannel === 1 ? "left" : "right",
        start: segment.start,
        end: segment.end,
        timestamp: formatTimestamp(segment.start),
      };
    });
  }

  // Fallback to parsing text if no segments
  if (!transcriptionText) return [];

  const lines = transcriptionText.split("\n").filter((line) => line.trim());
  const messages = [];

  for (const line of lines) {
    // Match "Channel 1: text" or "Channel 2: text"
    const match = line.match(/^Channel\s+(\d+):\s*(.+)$/i);
    if (match) {
      const channel = parseInt(match[1], 10);
      const text = match[2].trim();
      if (text) {
        messages.push({
          channel,
          text,
          // Channel 1 is typically the caller (left), Channel 2 is typically the agent/system (right)
          side: channel === 1 ? "left" : "right",
          timestamp: null,
        });
      }
    } else if (line.trim()) {
      // If no channel prefix, add to last message or create a new one
      if (messages.length > 0) {
        messages[messages.length - 1].text += " " + line.trim();
      } else {
        // Default to Channel 1 if no prefix
        messages.push({
          channel: 1,
          text: line.trim(),
          side: "left",
          timestamp: null,
        });
      }
    }
  }

  return messages;
}

export default function TranscriptionSheet({
  transcriptionText,
  transcriptionSegments,
  transcriptionSummary,
  open,
  onOpenChange,
}) {
  const messages = useMemo(() => {
    return parseTranscription(transcriptionText, transcriptionSegments);
  }, [transcriptionText, transcriptionSegments]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <IconFileText className="h-5 w-5 text-telnyx-green" />
            Call Transcription
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 min-h-0 flex flex-col gap-4 mt-4 px-4">
          {/* Summary Card */}
          {transcriptionSummary && (
            <Card className="mx-0">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <IconClipboard className="h-4 w-4 text-telnyx-green" />
                  Call Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="text-xs text-muted-foreground prose prose-xs dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_strong]:text-foreground">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {transcriptionSummary}
                  </ReactMarkdown>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Transcription Messages Card */}
          <Card className="flex-1 min-h-0 flex flex-col mx-0">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <IconMessage className="h-4 w-4 text-telnyx-green" />
                Transcription
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 p-0">
              <ScrollArea className="h-full px-4 pb-4">
                {messages.length === 0 ? (
                  <div className="text-sm text-muted-foreground p-4 text-center">
                    No transcription available
                  </div>
                ) : (
                  <Conversation>
                    <ConversationContent>
                      {messages.map((msg, index) => {
                        const isLeft = msg.side === "left";
                        return (
                          <Message
                            key={index}
                            from={isLeft ? "user" : "assistant"}
                          >
                            <MessageAvatar
                              className={
                                isLeft
                                  ? "ring-emerald-500"
                                  : "ring-telnyx-green"
                              }
                              icon={
                                isLeft ? (
                                  <IconUser className="size-4 text-emerald-600" />
                                ) : (
                                  <IconPhone className="size-4 text-telnyx-green" />
                                )
                              }
                            />
                            <MessageContent variant="contained" className="flex items-end justify-between gap-2">
                              <div className="whitespace-pre-wrap flex-1">{msg.text}</div>
                              {msg.timestamp && (
                                <div className="text-xs text-muted-foreground opacity-70 shrink-0">
                                  {msg.timestamp}
                                </div>
                              )}
                            </MessageContent>
                          </Message>
                        );
                      })}
                    </ConversationContent>
                  </Conversation>
                )}
              </ScrollArea>
            </CardContent>
          </Card>

        </div>

        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

