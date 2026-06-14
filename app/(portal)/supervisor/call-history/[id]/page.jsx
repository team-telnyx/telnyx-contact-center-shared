"use client";

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

export default function SupervisorCallHistoryDetailPage() {
  const params = useParams();
  const interactionId = params?.id;
  const [interaction, setInteraction] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copiedField, setCopiedField] = useState(null);

  useEffect(() => {
    if (!interactionId) return;
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/contact-center/interactions/${encodeURIComponent(interactionId)}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!res.ok)
          throw new Error(data?.error || "Failed to load interaction");
        setInteraction(data.interaction || null);
      } catch (err) {
        notify({
          title: "Load failed",
          description: String(err.message || err),
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    };
    load();
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

  // Check if this interaction used workflow mode
  const assistConfig = interaction?.metadata?.agent_assist_config;
  const isWorkflowMode = assistConfig?.assist_type === "workflows" && assistConfig?.workflow_id;

  const startedAt =
    interaction?.answered_at ||
    interaction?.assigned_at ||
    interaction?.enqueued_at ||
    interaction?.created_at;
  const durationSeconds =
    interaction?.handle_time_seconds ??
    (interaction?.completed_at && startedAt
      ? Math.floor(
          (new Date(interaction.completed_at) - new Date(startedAt)) / 1000,
        )
      : null);

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
              Timeline · Recordings
            </Badge>
          </>
        )}
        actions={(
          <Button variant="outline" size="sm" asChild>
            <Link href="/supervisor/call-history">
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
            <div className="py-2">
              <Skeleton className="h-6 w-1/3 mb-3" />
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : !interaction ? (
            <div className="py-2 text-sm text-muted-foreground">
              Interaction not found.
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {/* Participants */}
                <Card className="group relative overflow-hidden border-border/70 bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:bg-zinc-950/70" data-testid="participants-tile">
                  <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-500 to-cyan-400" aria-hidden="true" />
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2.5 text-base">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300">
                        <IconUsers className="h-5 w-5" />
                      </span>
                      Participants
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 p-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-300">
                        <IconUser className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                          {interaction.from_name || "Unknown caller"}
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {interaction.from_number || "-"}
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0 border-border/70 bg-background/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Caller
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 p-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
                        <IconHeadset className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                          {interaction.agent_name || interaction.agent_username || "Unassigned"}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {interaction.agent_username || "-"}
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
                        {interaction.queue_name || "-"}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>

                {/* Call Details */}
                <Card className="group relative overflow-hidden border-border/70 bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:bg-zinc-950/70" data-testid="call-details-tile">
                  <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-500 to-teal-400" aria-hidden="true" />
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2.5 text-base">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                        <IconPhone className="h-5 w-5" />
                      </span>
                      Call Details
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-center">
                        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Status</div>
                        <Badge
                          variant="outline"
                          className={`mt-1.5 uppercase ${
                            String(interaction.state || "").includes("complete")
                              ? "border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400"
                              : String(interaction.state || "").includes("abandon")
                                ? "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400"
                                : "border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400"
                          }`}
                        >
                          {interaction.state || "unknown"}
                        </Badge>
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
                        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Duration</div>
                        <div className="mt-1.5 font-mono text-sm font-semibold tabular-nums">
                          {formatDuration(durationSeconds)}
                        </div>
                      </div>
                      <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-center">
                        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Started</div>
                        <div className="mt-1.5 text-xs font-medium leading-snug">
                          {formatDateTime(startedAt)}
                        </div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <IconTag className="h-3.5 w-3.5" />
                        Wrap-up codes
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {Array.isArray(interaction.wrapup_code_names) &&
                        interaction.wrapup_code_names.length > 0 ? (
                          interaction.wrapup_code_names.map((name) => (
                            <Badge
                              key={name}
                              variant="outline"
                              className="border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300"
                            >
                              {name}
                            </Badge>
                          ))
                        ) : Array.isArray(interaction.wrapup_codes) &&
                          interaction.wrapup_codes.length > 0 ? (
                          interaction.wrapup_codes.map((code) => (
                            <Badge
                              key={code}
                              variant="outline"
                              className="border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300"
                            >
                              {code}
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
                <Card className="group relative overflow-hidden border-border/70 bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:bg-zinc-950/70 md:col-span-2 xl:col-span-1" data-testid="call-ids-tile">
                  <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-500 to-fuchsia-400" aria-hidden="true" />
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2.5 text-base">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300">
                        <IconId className="h-5 w-5" />
                      </span>
                      Call IDs
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {[
                      ["Interaction ID", interaction.id],
                      ["Call Control ID", interaction.call_control_id],
                      ["Call Session ID", interaction.call_session_id],
                    ].map(([label, value]) => (
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
                    aiCallControlId ? "grid-cols-4" : "grid-cols-3"
                  }`}
                >
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  <TabsTrigger value="recording">Recording</TabsTrigger>
                  <TabsTrigger value="transcript">Transcript</TabsTrigger>
                  {aiCallControlId && (
                    <TabsTrigger value="ai">AI Assistant</TabsTrigger>
                  )}
                </TabsList>

                <TabsContent value="timeline" className="mt-4 space-y-4">
                  <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <IconTimeline className="h-5 w-5 text-sky-500" />
                        Call Phases
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        How the call time was split across IVR, queue, agent interaction, and wrap-up.
                      </p>
                    </CardHeader>
                    <CardContent>
                      <InteractionTimeline events={timelineEvents} />
                    </CardContent>
                  </Card>

                  {interaction?.routing_metadata?.timeline &&
                    Array.isArray(interaction.routing_metadata.timeline) &&
                    interaction.routing_metadata.timeline.length > 0 && (
                      <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <IconHistory className="h-5 w-5 text-violet-500" />
                            Event Journey
                          </CardTitle>
                          <p className="text-sm text-muted-foreground">
                            Every routing event from first ring to wrap-up, with timing between steps.
                          </p>
                        </CardHeader>
                        <CardContent>
                          <RoutingMetadataTimeline
                            events={interaction.routing_metadata.timeline}
                          />
                        </CardContent>
                      </Card>
                    )}
                </TabsContent>

                <TabsContent value="recording" className="mt-4 space-y-4">
                  {recordingUrl ? (
                    <>
                      <RecordingPlayer
                        ref={playerRef}
                        src={recordingUrl}
                        recordingId={recordingId}
                        format={recordingFormat}
                        channels={recordingChannels}
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
                    <Card className="border-dashed border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
                      <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground">
                          <IconMicrophoneOff className="h-6 w-6" />
                        </span>
                        <div>
                          <div className="text-sm font-semibold">No recording available</div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            This interaction was not recorded or the recording has not been stored yet.
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

                {aiCallControlId && (
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
