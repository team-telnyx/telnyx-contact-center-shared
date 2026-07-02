"use client";

import { useMemo } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
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
import {
  IconUser,
  IconHeadset,
  IconFileText,
  IconClipboard,
  IconMessages,
} from "@tabler/icons-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import DiarizedTranscript from "./DiarizedTranscript";

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

function formatConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const normalized = num > 1 ? num / 100 : num;
  return `${Math.round(Math.max(0, Math.min(1, normalized)) * 100)}%`;
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
  speakerTurns = [],
  details = null,
  open,
  onOpenChange,
  playbackTime = 0,
  playbackPlaying = false,
  onSeekRecording = null,
}) {
  const messages = useMemo(() => {
    return parseTranscription(transcriptionText, transcriptionSegments);
  }, [transcriptionText, transcriptionSegments]);

  const hasSpeakerTurns = Array.isArray(speakerTurns) && speakerTurns.length > 0;
  const speakerCount = hasSpeakerTurns
    ? new Set(speakerTurns.map((turn) => turn.speaker)).size
    : 0;
  const confidenceLabel = formatConfidence(details?.confidence);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border/60 px-6 py-4">
          <SheetTitle className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300">
              <IconMessages className="h-4.5 w-4.5" />
            </span>
            Call Transcription
          </SheetTitle>
          <SheetDescription>
            {hasSpeakerTurns
              ? "Diarized conversation with speaker turns and timestamps."
              : "Conversation reconstructed from transcription segments."}
          </SheetDescription>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {details?.model && (
              <Badge variant="outline" className="border-border/70 bg-muted/40 font-mono text-[10px]">
                {details.model}
              </Badge>
            )}
            {hasSpeakerTurns && (
              <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300">
                {speakerCount} speakers · {speakerTurns.length} turns
              </Badge>
            )}
            {confidenceLabel && (
              <Badge variant="outline" className="border-border/70 bg-muted/40 text-[10px]">
                Confidence {confidenceLabel}
              </Badge>
            )}
          </div>
        </SheetHeader>
        <div className="mt-0 flex min-h-0 flex-1 flex-col gap-4 px-4 pt-4">
          {/* Summary Card */}
          {transcriptionSummary && (
            <Card className="mx-0 border-border/70 bg-muted/20">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <IconClipboard className="h-4 w-4 text-violet-500" />
                  Call Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {transcriptionSummary}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Conversation Card */}
          <Card className="mx-0 flex min-h-0 flex-1 flex-col border-border/70">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <IconFileText className="h-4 w-4 text-violet-500" />
                {hasSpeakerTurns ? "Speaker Timeline" : "Transcription"}
              </CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 p-0">
              <ScrollArea className="h-full">
                {hasSpeakerTurns ? (
                  <DiarizedTranscript
                    speakerTurns={speakerTurns}
                    currentTime={playbackTime}
                    isPlaying={playbackPlaying}
                    onSeek={onSeekRecording}
                  />
                ) : messages.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    No transcription available
                  </div>
                ) : (
                  <div className="px-4 pb-4">
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
                                    <IconHeadset className="size-4 text-telnyx-green" />
                                  )
                                }
                              />
                              <MessageContent variant="contained" className="flex items-end justify-between gap-2">
                                <div className="flex-1 whitespace-pre-wrap">{msg.text}</div>
                                {msg.timestamp && (
                                  <div className="shrink-0 text-xs text-muted-foreground opacity-70">
                                    {msg.timestamp}
                                  </div>
                                )}
                              </MessageContent>
                            </Message>
                          );
                        })}
                      </ConversationContent>
                    </Conversation>
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        <SheetFooter className="flex flex-row justify-end gap-2 border-t px-6 py-4">
          <Button onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
