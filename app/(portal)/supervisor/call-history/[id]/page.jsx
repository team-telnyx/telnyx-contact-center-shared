"use client";

import { useEffect, useMemo, useState } from "react";
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
  IconId,
  IconPhone,
  IconUsers,
  IconTimeline,
  IconRobot,
  IconHistory,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import InteractionTimeline from "@/components/contact-center/InteractionTimeline";
import RoutingMetadataTimeline from "@/components/contact-center/RoutingMetadataTimeline";
import RecordingPlayer from "@/components/contact-center/RecordingPlayer";
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
  const aiCallControlId = interaction?.metadata?.ai_call_control_id || null;
  const [aiSheetOpen, setAiSheetOpen] = useState(false);

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
              <div className="grid gap-4 md:grid-cols-3">
                <Card className="border-l-4 border-l-blue-500">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <IconUsers className="h-5 w-5 text-blue-500" />
                      Participants
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Caller Number
                      </span>
                      <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                        {interaction.from_number || "-"}
                      </code>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Caller Name
                      </span>
                      <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                        {interaction.from_name || "Unknown"}
                      </code>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Agent
                      </span>
                      <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                        {interaction.agent_name ||
                          interaction.agent_username ||
                          "-"}
                      </code>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Queue
                      </span>
                      <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                        {interaction.queue_name || "-"}
                      </code>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-l-4 border-l-green-500">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <IconPhone className="h-5 w-5 text-green-500" />
                      Call Details
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Direction
                      </span>
                      <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                        {interaction.direction || "-"}
                      </code>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Status
                      </span>
                      <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all uppercase">
                        {interaction.state || "unknown"}
                      </code>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Started
                      </span>
                      <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                        {formatDateTime(startedAt)}
                      </code>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Duration
                      </span>
                      <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                        {formatDuration(durationSeconds)}
                      </code>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Wrapup Codes
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {Array.isArray(interaction.wrapup_code_names) &&
                        interaction.wrapup_code_names.length > 0 ? (
                          interaction.wrapup_code_names.map((name) => (
                            <Badge
                              key={name}
                              variant="outline"
                              className="border-green-500 text-green-600"
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
                              className="border-green-500 text-green-600"
                            >
                              {code}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            -
                          </span>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-l-4 border-l-purple-500">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <IconId className="h-5 w-5 text-purple-500" />
                      Call IDs
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Interaction ID
                      </span>
                      <div className="flex items-center gap-2">
                        <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all flex-1">
                          {interaction.id || "-"}
                        </code>
                        {interaction.id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            onClick={() =>
                              handleCopy(interaction.id, "Interaction ID")
                            }
                          >
                            {copiedField === "Interaction ID" ? (
                              <IconCheck className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <IconCopy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Call Control ID
                      </span>
                      <div className="flex items-center gap-2">
                        <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all flex-1">
                          {interaction.call_control_id || "-"}
                        </code>
                        {interaction.call_control_id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            onClick={() =>
                              handleCopy(
                                interaction.call_control_id,
                                "Call Control ID",
                              )
                            }
                          >
                            {copiedField === "Call Control ID" ? (
                              <IconCheck className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <IconCopy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="text-sm text-muted-foreground">
                        Call Session ID
                      </span>
                      <div className="flex items-center gap-2">
                        <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all flex-1">
                          {interaction.call_session_id || "-"}
                        </code>
                        {interaction.call_session_id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            onClick={() =>
                              handleCopy(
                                interaction.call_session_id,
                                "Call Session ID",
                              )
                            }
                          >
                            {copiedField === "Call Session ID" ? (
                              <IconCheck className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <IconCopy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
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
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <IconTimeline className="h-5 w-5 text-blue-500" />
                        Interaction Timeline
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <InteractionTimeline events={timelineEvents} />
                    </CardContent>
                  </Card>

                  {interaction?.routing_metadata?.timeline &&
                    Array.isArray(interaction.routing_metadata.timeline) &&
                    interaction.routing_metadata.timeline.length > 0 && (
                      <Card>
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <IconHistory className="h-5 w-5 text-purple-500" />
                            Detailed Event Timeline
                          </CardTitle>
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
                    <RecordingPlayer
                      src={recordingUrl}
                      recordingId={recordingId}
                      format={recordingFormat}
                      channels={recordingChannels}
                      transcriptionText={transcriptionText}
                      transcriptionSegments={transcriptionSegments}
                      transcriptionSummary={transcriptionSummary}
                      interactionId={interaction?.id || null}
                    />
                  ) : (
                    <Card>
                      <CardContent className="py-8 text-sm text-muted-foreground">
                        No recording available for this interaction.
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
