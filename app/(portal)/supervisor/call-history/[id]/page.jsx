"use client";

import { ConversationReader } from "@/components/contact-center/ConversationPreview";
import { InteractionChannel } from "@/components/contact-center/InteractionChannel";
import InteractionStateBadge from "@/components/contact-center/InteractionStateBadge";
import InteractionSla from "@/components/contact-center/InteractionSla";
import { channelDefinition } from "@/lib/acd/channel-registry.mjs";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconArrowLeft,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconHeadset,
  IconId,
  IconPhone,
  IconPhoneIncoming,
  IconPhoneOutgoing,
  IconTag,
  IconUser,
  IconUsers,
  IconUsersGroup,
  IconTimeline,
  IconRobot,
  IconHistory,
  IconMicrophoneOff,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import InteractionTimeline from "@/components/contact-center/InteractionTimeline";
import RoutingMetadataTimeline from "@/components/contact-center/RoutingMetadataTimeline";
import RecordingPlayer from "@/components/contact-center/RecordingPlayer";
import TranscriptionStudioCard from "@/components/contact-center/TranscriptionStudioCard";
import TranscriptionHistory from "@/components/contact-center/TranscriptionHistory";
import WorkflowHistoryView from "@/components/contact-center/WorkflowHistoryView";
import AiConversationSheet from "@/components/contact-center/AiConversationSheet";
import {
  SupervisorPageContent,
  SupervisorPageHeader,
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
import { SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { AnalyticsSectionRailNav } from "@/components/contact-center/AnalyticsSectionNav";

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "-";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const pad2 = (value) => String(value).padStart(2, "0");
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}`;
}

function SegmentNavigator({ index, count, onChange }) {
  if (count <= 1) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/30 p-1"
      data-testid="segment-navigator"
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        disabled={index === 0}
        onClick={() => onChange(index - 1)}
        aria-label="Previous interaction segment"
      >
        <IconChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <span className="min-w-[5.5rem] text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Segment {index + 1} of {count}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        disabled={index >= count - 1}
        onClick={() => onChange(index + 1)}
        aria-label="Next interaction segment"
      >
        <IconChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export default function SupervisorCallHistoryDetailPage() {
  const params = useParams();
  const interactionId = params?.id;
  const [interaction, setInteraction] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [copiedField, setCopiedField] = useState(null);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);

  useEffect(() => {
    if (!interactionId) return;
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      setInteraction(null);
      setActiveSegmentIndex(0);
      try {
        const res = await fetch(
          `/api/contact-center/interactions/${encodeURIComponent(interactionId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await res.json();
        if (!res.ok)
          throw new Error(data?.error || "Failed to load interaction");
        if (!controller.signal.aborted) setInteraction(data.interaction || null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setLoadError(String(err.message || err));
        notify({
          title: "Load failed",
          description: String(err.message || err),
          variant: "error",
        });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, [interactionId]);

  const timelineEvents = useMemo(() => {
    if (!interaction?.routing_metadata) return [];
    const timeline = interaction.routing_metadata.timeline || [];
    const events = Array.isArray(timeline) ? timeline : [];
    // Filter out agent_timeout events - these are internal routing events that shouldn't be displayed
    return events.filter((event) => event.type !== "agent_timeout");
  }, [interaction]);

  const transcriptions =
    interaction?.metadata?.agent_assist?.transcriptions || [];

  const callSegments = useMemo(() => {
    if (!interaction) return [];
    if (
      Array.isArray(interaction.acd_segments) &&
      interaction.acd_segments.length > 0
    ) {
      return interaction.acd_segments;
    }
    return [
      {
        id: interaction.id,
        source: "legacy",
        queue_id: interaction.queue_id,
        queue_name: interaction.queue_name,
        agent_id: interaction.agent_id,
        agent_name: interaction.agent_name,
        agent_username: interaction.agent_username,
        started_at:
          interaction.answered_at ||
          interaction.assigned_at ||
          interaction.enqueued_at ||
          interaction.created_at,
        answered_at: interaction.answered_at,
        ended_at: interaction.completed_at,
        outcome: interaction.state,
        wrapup_code_names:
          interaction.wrapup_code_names?.length > 0
            ? interaction.wrapup_code_names
            : interaction.wrapup_codes || [],
        agent_call_control_id: interaction.call_control_id,
        agent_call_session_id: interaction.call_session_id,
        handle_time_seconds: interaction.handle_time_seconds,
      },
    ];
  }, [interaction]);

  useEffect(() => {
    setActiveSegmentIndex((current) =>
      Math.min(current, Math.max(0, callSegments.length - 1)),
    );
  }, [callSegments.length]);

  const activeSegment = callSegments[activeSegmentIndex] || null;
  const activeSegmentStartedAt =
    activeSegment?.answered_at || activeSegment?.started_at || null;
  const activeSegmentDurationSeconds =
    activeSegment?.handle_time_seconds ??
    (activeSegmentStartedAt && activeSegment?.ended_at
      ? Math.floor(
          (new Date(activeSegment.ended_at) -
            new Date(activeSegmentStartedAt)) /
            1000,
        )
      : null);
  const activeSegmentStatus =
    activeSegment?.outcome || interaction?.state || "unknown";
  const activeSegmentWrapupCodes = Array.isArray(
    activeSegment?.wrapup_code_names,
  )
    ? activeSegment.wrapup_code_names
    : [];

  // Check if this interaction used workflow mode
  const assistConfig = interaction?.metadata?.agent_assist_config;
  const isWorkflowMode = assistConfig?.assist_type === "workflows" && assistConfig?.workflow_id;

  const handleCopy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (_) {
      // Ignore copy errors
    }
  };

  const recordingMetadata = interaction?.metadata?.recording || null;
  const recordingUrl =
    interaction?.recording_url ||
    recordingMetadata?.recording_url ||
    recordingMetadata?.recording_urls?.mp3 ||
    null;
  const recordingId = recordingMetadata?.recording_id || null;
  const recordingFormat = recordingMetadata?.format || null;
  const recordingChannels = recordingMetadata?.channels || null;
  const transcriptionText = interaction?.metadata?.transcription_text || null;
  const transcriptionSegments =
    interaction?.metadata?.transcription_segments || null;
  const transcriptionSummary =
    interaction?.metadata?.transcription_summary || null;
  const transcriptionSpeakerTurns =
    interaction?.metadata?.transcription_speaker_turns || [];
  const transcriptionDetails =
    interaction?.metadata?.transcription_details || null;
  const aiCallControlId = interaction?.metadata?.ai_call_control_id || null;
  const [aiSheetOpen, setAiSheetOpen] = useState(false);

  // Recording playback state shared with the transcription sheet so its diarized
  // bubbles highlight/scroll to the turn being played and clicking seeks.
  const playerRef = useRef(null);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackPlaying, setPlaybackPlaying] = useState(false);
  const seekRecordingTo = (seconds) => playerRef.current?.seekToTime(seconds);

  const channel = interaction?.interaction_type || interaction?.channel || "voice";
  const isMessaging = Boolean(channelDefinition(channel).capabilities.conversation);
  const isVoice = channelDefinition(channel).family === "voice";
  // Web video calls are composed to mp4 by Telnyx Video Rooms; everything else is audio.
  const isVideoRecording = channel === "video" || recordingFormat === "mp4";
  const identifiers = isVoice ? [
    ["Interaction ID", interaction?.id],
    ["Customer Call Control ID", interaction?.call_control_id],
    ["Agent Call Control ID", activeSegment?.agent_call_control_id],
    ["Agent Call Session ID", activeSegment?.agent_call_session_id],
  ] : [
    ["Interaction ID", interaction?.id],
    ["Conversation ID", interaction?.conversation_id],
    ["Segment ID", activeSegment?.id],
    ["Agent ID", activeSegment?.agent_id],
  ];
  return (
    <SupervisorPageShell>
      <SupervisorPageHeader
        title="Interaction Details"
        badges={(
          <>
            <Badge
              variant="outline"
              className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
            >
              Interaction record
            </Badge>
            <Badge
              variant="outline"
              className="border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300"
            >
              {isMessaging ? "Timeline · Preview" : "Timeline · Recordings"}
            </Badge>
          </>
        )}
        actions={(
          <Button variant="outline" size="sm" asChild>
            <Link href="/supervisor/interactions-history">
              <IconArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Link>
          </Button>
        )}
      />
      <main
        className={SECTION_RAIL_PAGE_GRID_CLASS}
        style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}
      >
        <AnalyticsSectionRailNav activeId="call-history" />
        <section className="h-full min-h-0 overflow-y-auto pr-1">
        <Card className="shadow-sm">
          <CardContent className="space-y-6 py-6">
          {loading ? (
            <div className="space-y-6" aria-label="Loading interaction details">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0,1,2].map(index => <Skeleton key={index} className="h-64" />)}</div>
              <Skeleton className="h-10 w-full" /><Skeleton className="h-64 w-full" />
            </div>
          ) : loadError ? (
            <div role="alert" className="rounded-xl border border-destructive/30 p-5 text-sm text-destructive">{loadError}</div>
          ) : !interaction ? (
            <div className="py-2 text-sm text-muted-foreground">
              Interaction not found.
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {/* Participants */}
                <Card className="group relative overflow-hidden border-border/70 bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md" data-testid="participants-tile">
                  <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-500 to-cyan-400" aria-hidden="true" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="flex items-center gap-2.5 text-base">
                        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300">
                          <IconUsers className="h-5 w-5" />
                        </span>
                        Participants
                      </CardTitle>
                      <SegmentNavigator
                        index={activeSegmentIndex}
                        count={callSegments.length}
                        onChange={setActiveSegmentIndex}
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 p-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-300">
                        <IconUser className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                          {interaction.from_name || "Unknown customer"}
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {interaction.from_number || "-"}
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0 border-border/70 bg-background/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Customer
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 p-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
                        <IconHeadset className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                          {activeSegment?.agent_name || activeSegment?.agent_username || "Unassigned"}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {activeSegment?.agent_username || "-"}
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0 border-border/70 bg-background/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Agent
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <IconUsersGroup className="h-3.5 w-3.5" />
                        Queue
                      </span>
                      <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-xs text-sky-700 dark:text-sky-300">
                        {activeSegment?.queue_name || "-"}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>

                {/* Call Details */}
                <Card className="group relative overflow-hidden border-border/70 bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md" data-testid="call-details-tile">
                  <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-500 to-teal-400" aria-hidden="true" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="flex items-center gap-2.5 text-base">
                        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                          <InteractionChannel channel={channel} />
                        </span>
                        Interaction Details
                      </CardTitle>
                      <SegmentNavigator
                        index={activeSegmentIndex}
                        count={callSegments.length}
                        onChange={setActiveSegmentIndex}
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{channelDefinition(channel).label}</span><InteractionSla sla={interaction.sla} />
                    </div>
                    {interaction.subject && <p className="truncate text-sm font-medium" title={interaction.subject}>{interaction.subject}</p>}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-center">
                        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Status</div>
                        <InteractionStateBadge state={activeSegmentStatus} className="mt-1.5" />
                      </div>
                      <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-center">
                        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Direction</div>
                        <div className="mt-1.5 flex items-center justify-center gap-1.5 text-sm font-semibold capitalize">
                          {String(interaction.direction || "").includes("out") ? (
                            <IconPhoneOutgoing className="h-4 w-4 text-violet-500" />
                          ) : (
                            <IconPhoneIncoming className="h-4 w-4 text-emerald-500" />
                          )}
                          {interaction.direction || "-"}
                        </div>
                      </div>
                      <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-center">
                        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Handling duration</div>
                        <div className="mt-1.5 font-mono text-sm font-semibold tabular-nums">
                          {formatDuration(activeSegmentDurationSeconds)}
                        </div>
                      </div>
                      <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-center">
                        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Started</div>
                        <div className="mt-1.5 text-xs font-medium leading-snug">
                          {formatDateTime(activeSegmentStartedAt)}
                        </div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <IconTag className="h-3.5 w-3.5" />
                        Wrap-up codes
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {activeSegmentWrapupCodes.length > 0 ? (
                          activeSegmentWrapupCodes.map((name) => (
                            <Badge
                              key={name}
                              variant="outline"
                              className="border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300"
                            >
                              {name}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">No codes recorded</span>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Call IDs */}
                <Card className="group relative overflow-hidden border-border/70 bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md md:col-span-2 xl:col-span-1" data-testid="call-ids-tile">
                  <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-500 to-fuchsia-400" aria-hidden="true" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="flex items-center gap-2.5 text-base">
                        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300">
                          <IconId className="h-5 w-5" />
                        </span>
                        Identifiers
                      </CardTitle>
                      <SegmentNavigator
                        index={activeSegmentIndex}
                        count={callSegments.length}
                        onChange={setActiveSegmentIndex}
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {identifiers.map(([label, value]) => (
                      <div key={label} className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                            {label}
                          </span>
                          {value ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0 opacity-60 transition group-hover:opacity-100"
                              onClick={() => handleCopy(value, label)}
                              aria-label={`Copy ${label}`}
                            >
                              {copiedField === label ? (
                                <IconCheck className="h-3.5 w-3.5 text-green-500" />
                              ) : (
                                <IconCopy className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          ) : null}
                        </div>
                        <code className="mt-0.5 block break-all font-mono text-xs text-foreground/80">
                          {value || "-"}
                        </code>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>

              <Tabs defaultValue="timeline" className="w-full">
                <TabsList
                  className={`grid w-full ${
                    isMessaging ? "grid-cols-2" : aiCallControlId ? "grid-cols-4" : "grid-cols-3"
                  }`}
                >
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  {isMessaging ? <TabsTrigger value="preview">Preview</TabsTrigger> : <>
                    <TabsTrigger value="recording">Recording</TabsTrigger>
                    <TabsTrigger value="transcript">Transcript</TabsTrigger>
                  </>}
                  {!isMessaging && aiCallControlId && (
                    <TabsTrigger value="ai">AI Assistant</TabsTrigger>
                  )}
                </TabsList>

                <TabsContent value="timeline" className="mt-4 space-y-4">
                  <Card className="border-border/70 bg-card shadow-sm">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <IconTimeline className="h-5 w-5 text-sky-500" />
                        Interaction Phases
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {isVoice ? "Time across IVR, queue, agent handling and wrap-up." : "Time across intake, queue, agent handling and wrap-up."}
                      </p>
                    </CardHeader>
                    <CardContent>
                      <InteractionTimeline events={timelineEvents} channel={channel} />
                    </CardContent>
                  </Card>

                  {interaction?.routing_metadata?.timeline &&
                    Array.isArray(interaction.routing_metadata.timeline) &&
                    interaction.routing_metadata.timeline.length > 0 && (
                      <Card className="border-border/70 bg-card shadow-sm">
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <IconHistory className="h-5 w-5 text-violet-500" />
                            Event Journey
                          </CardTitle>
                          <p className="text-sm text-muted-foreground">
                            Routing events from arrival to wrap-up, with timing between steps.
                          </p>
                        </CardHeader>
                        <CardContent>
                          <RoutingMetadataTimeline
                            channel={channel}
                            events={interaction.routing_metadata.timeline}
                          />
                        </CardContent>
                      </Card>
                    )}
                </TabsContent>

                {isMessaging && <TabsContent value="preview" className="mt-4">
                  <div className="relative h-[min(70dvh,850px)] min-h-[400px] overflow-hidden rounded-xl border" data-testid="history-conversation-preview">
                    <ConversationReader key={interaction.id} workItemId={interaction.work_item_id || interaction.id} />
                  </div>
                </TabsContent>}
                <TabsContent value="recording" className="mt-4 space-y-4">
                  {recordingUrl ? (
                    <>
                      <RecordingPlayer
                        ref={playerRef}
                        src={recordingUrl}
                        recordingId={recordingId}
                        format={recordingFormat}
                        channels={recordingChannels}
                        video={isVideoRecording}
                        onTimeUpdate={setPlaybackTime}
                        onPlayingChange={setPlaybackPlaying}
                      />
                      <TranscriptionStudioCard
                        recordingId={recordingId}
                        interactionId={interaction?.id || null}
                        transcriptionText={transcriptionText}
                        transcriptionSegments={transcriptionSegments}
                        transcriptionSummary={transcriptionSummary}
                        transcriptionSpeakerTurns={transcriptionSpeakerTurns}
                        transcriptionDetails={transcriptionDetails}
                        playbackTime={playbackTime}
                        playbackPlaying={playbackPlaying}
                        onSeekRecording={seekRecordingTo}
                      />
                    </>
                  ) : (
                    <Card className="border-dashed border-border/70 bg-card shadow-sm">
                      <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground">
                          <IconMicrophoneOff className="h-6 w-6" />
                        </span>
                        <div>
                          <div className="text-sm font-semibold">No recording available</div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {channel === "video"
                              ? "The composed video recording is not ready yet, or recording was disabled for this widget."
                              : "This interaction was not recorded or the recording has not been stored yet."}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                <TabsContent value="transcript" className="mt-4 space-y-4">
                  {isWorkflowMode ? (
                    <WorkflowHistoryView interactionId={interaction.id} />
                  ) : Array.isArray(transcriptions) &&
                  transcriptions.length > 0 ? (
                    <TranscriptionHistory transcriptions={transcriptions} />
                  ) : (
                    <Card>
                      <CardContent className="py-8 text-sm text-muted-foreground">
                        No transcription data stored for this interaction.
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                {!isMessaging && aiCallControlId && (
                  <TabsContent value="ai" className="mt-4 space-y-4">
                    <Card>
                      <CardHeader className="flex-row items-center justify-between gap-2">
                        <CardTitle className="flex items-center gap-2">
                          <IconRobot className="h-5 w-5 text-violet-500" />
                          AI Assistant
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid grid-cols-[160px_1fr] gap-2 items-start">
                          <span className="text-sm text-muted-foreground">
                            AI Call Control ID
                          </span>
                          <div className="flex items-center gap-2">
                            <code className="bg-muted px-2 py-1 rounded text-xs font-mono w-fit">
                              {aiCallControlId}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() =>
                                handleCopy(
                                  aiCallControlId,
                                  "AI Call Control ID",
                                )
                              }
                            >
                              {copiedField === "AI Call Control ID" ? (
                                <IconCheck className="h-3.5 w-3.5 text-green-500" />
                              ) : (
                                <IconCopy className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          className="bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                          onClick={() => setAiSheetOpen(true)}
                        >
                          Open AI Conversation
                        </Button>
                        {aiSheetOpen && (
                          <AiConversationSheet
                            interaction={interaction}
                            hideTrigger
                            stopPropagation
                            open={aiSheetOpen}
                            onOpenChange={setAiSheetOpen}
                          />
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>
                )}
              </Tabs>
            </>
          )}
          </CardContent>
        </Card>
        </section>
      </main>
    </SupervisorPageShell>
  );
}
