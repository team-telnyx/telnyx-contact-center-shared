"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBolt,
  IconCircleCheck,
  IconClipboardCheck,
  IconDeviceFloppy,
  IconGauge,
  IconHeadset,
  IconLoader2,
  IconQuote,
  IconRobot,
  IconRosetteDiscountCheck,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import RecordingPlayer from "@/components/contact-center/RecordingPlayer";
import {
  SupervisorPageHeader,
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
import { SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { QualitySectionRailNav } from "@/components/contact-center/QualitySectionNav";

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "-";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const STATUS_BADGES = {
  draft: { label: "Draft", className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  ai_processing: { label: "AI processing", className: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  ai_draft: { label: "AI draft", className: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  reviewed: { label: "Reviewed", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  final: { label: "Final", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  disputed: { label: "Disputed", className: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400" },
};

const AI_PHASE_LABELS = {
  queued: "Preparing…",
  transcribing: "Transcribing recording…",
  evaluating: "Scoring the form…",
};

function listCriteria(schema) {
  const items = [];
  for (const section of schema?.sections || []) {
    for (const criterion of section.criteria || []) {
      items.push({ ...criterion, sectionId: section.id, sectionTitle: section.title });
    }
  }
  return items;
}

function computeLocalScore(schema, answers, scoringConfig = {}) {
  let total = 0;
  let max = 0;
  let criticalFailed = false;
  for (const criterion of listCriteria(schema)) {
    const answer = answers?.[criterion.id];
    if (answer?.na === true) continue;
    const weight = Number(criterion.weight || 1);
    max += Number(criterion.maxScore || 0) * weight;
    if (answer == null || answer.score == null) continue;
    const raw = Math.max(0, Math.min(Number(criterion.maxScore || 0), Number(answer.score)));
    total += raw * weight;
    if (criterion.criticalFail && raw <= 0) criticalFailed = true;
  }
  if (criticalFailed && scoringConfig?.criticalFailZeroesScore) total = 0;
  const percent = max > 0 ? Math.round((total / max) * 100) : 0;
  return { total, max, percent, criticalFailed };
}

function ScoreButtons({ criterion, answer, disabled, onScore }) {
  if (criterion.type === "boolean") {
    return (
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={answer?.score === 1 ? "default" : "outline"}
          className={answer?.score === 1 ? "bg-emerald-600 text-white hover:bg-emerald-700" : ""}
          disabled={disabled}
          onClick={() => onScore(1)}
        >
          Pass
        </Button>
        <Button
          type="button"
          size="sm"
          variant={answer?.score === 0 ? "default" : "outline"}
          className={answer?.score === 0 ? "bg-red-600 text-white hover:bg-red-700" : ""}
          disabled={disabled}
          onClick={() => onScore(0)}
        >
          Fail
        </Button>
      </div>
    );
  }
  const maxScore = Number(criterion.maxScore || 5);
  return (
    <div className="flex flex-wrap gap-1.5">
      {Array.from({ length: maxScore + 1 }, (_, score) => (
        <Button
          key={score}
          type="button"
          size="sm"
          variant={answer?.score === score ? "default" : "outline"}
          className={`h-8 w-8 p-0 ${answer?.score === score ? "bg-emerald-600 text-white hover:bg-emerald-700" : ""}`}
          disabled={disabled}
          onClick={() => onScore(score)}
        >
          {score}
        </Button>
      ))}
    </div>
  );
}

export default function QualityEvaluationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const evaluationId = params?.id;

  const [loading, setLoading] = useState(true);
  const [evaluation, setEvaluation] = useState(null);
  const [interaction, setInteraction] = useState(null);
  const [answers, setAnswers] = useState({});
  const [reviewNotes, setReviewNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiPhase, setAiPhase] = useState(null);

  const load = useCallback(async () => {
    if (!evaluationId) return;
    try {
      const res = await fetch(`/api/contact-center/quality/evaluations/${evaluationId}`, {
        cache: "no-store",
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to load evaluation");
      setEvaluation(payload.evaluation);
      setInteraction(payload.interaction);
      setAnswers(payload.evaluation?.answers || {});
      setReviewNotes(payload.evaluation?.review_notes || "");
    } catch (error) {
      notify({
        title: "Failed to load evaluation",
        description: String(error.message || error),
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [evaluationId]);

  useEffect(() => {
    load();
  }, [load]);

  const schema = evaluation?.form_schema || { sections: [] };
  const scoringConfig = evaluation?.form_scoring_config || {};
  const isFinal = evaluation?.status === "final";
  const aiResult = evaluation?.ai_result || null;

  const localScore = useMemo(
    () => computeLocalScore(schema, answers, scoringConfig),
    [schema, answers, scoringConfig],
  );

  const recordingMetadata = interaction?.metadata?.recording || null;
  const recordingUrl =
    interaction?.recording_url ||
    recordingMetadata?.recording_url ||
    recordingMetadata?.recording_urls?.mp3 ||
    null;
  const recordingId = recordingMetadata?.recording_id || null;
  const transcriptionText = interaction?.metadata?.transcription_text || null;
  const speakerTurns = interaction?.metadata?.transcription_speaker_turns || [];

  const setAnswer = useCallback((criterionId, updates) => {
    setAnswers((previous) => ({
      ...previous,
      [criterionId]: { ...(previous[criterionId] || {}), ...updates, source: "human" },
    }));
  }, []);

  const save = useCallback(
    async (action = "save") => {
      setSaving(true);
      try {
        const res = await fetch(`/api/contact-center/quality/evaluations/${evaluationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers, review_notes: reviewNotes, action }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || "Failed to save evaluation");
        setEvaluation((previous) => ({ ...previous, ...payload.evaluation }));
        notify({
          title: action === "finalize" ? "Evaluation finalized" : "Evaluation saved",
          variant: "success",
        });
      } catch (error) {
        notify({
          title: "Failed to save evaluation",
          description: String(error.message || error),
          variant: "error",
        });
      } finally {
        setSaving(false);
      }
    },
    [evaluationId, answers, reviewNotes],
  );

  const runAiEvaluation = useCallback(async () => {
    setAiRunning(true);
    setAiPhase("queued");

    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/contact-center/quality/evaluations/${evaluationId}/ai`, {
          cache: "no-store",
        });
        const payload = await res.json();
        if (res.ok && payload.job?.status) {
          setAiPhase(payload.job.status);
        }
      } catch {
        // Polling is best-effort; the POST below carries the real result.
      }
    }, 2500);

    try {
      const res = await fetch(`/api/contact-center/quality/evaluations/${evaluationId}/ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "AI evaluation failed");
      notify({ title: "AI draft ready", description: "Review the scores and finalize.", variant: "success" });
      await load();
    } catch (error) {
      notify({
        title: "AI evaluation failed",
        description: String(error.message || error),
        variant: "error",
      });
    } finally {
      clearInterval(poll);
      setAiRunning(false);
      setAiPhase(null);
    }
  }, [evaluationId, load]);

  const statusConfig = STATUS_BADGES[evaluation?.status] || STATUS_BADGES.draft;
  const canRunAi = !isFinal && !aiRunning && Boolean(recordingId || recordingUrl || transcriptionText);

  return (
    <SupervisorPageShell>
      <SupervisorPageHeader
        title="Quality Evaluation"
        badges={(
          <>
            <Badge variant="outline" className={statusConfig.className}>{statusConfig.label}</Badge>
            {evaluation?.form_name ? (
              <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                {evaluation.form_name} · v{evaluation.form_version}
              </Badge>
            ) : null}
          </>
        )}
        actions={(
          <Button variant="outline" size="sm" asChild>
            <Link href="/supervisor/quality?section=evaluations">
              <IconArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>
        )}
      />
      <main
        className={SECTION_RAIL_PAGE_GRID_CLASS}
        style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}
      >
        <QualitySectionRailNav activeId="evaluations" />
        <section className="h-full min-h-0 overflow-y-auto pr-1 xl:overflow-hidden">
          {loading ? (
            <Card className="shadow-sm">
              <CardContent className="space-y-3 py-6">
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
            </Card>
          ) : !evaluation ? (
            <Card className="shadow-sm">
              <CardContent className="py-6 text-sm text-muted-foreground">
                Evaluation not found.
              </CardContent>
            </Card>
          ) : (
            <div className="grid h-full min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
              {/* Left column: interaction, recording, transcript — scrolls on its own */}
              <div className="min-h-0 space-y-4 xl:overflow-y-auto xl:pr-1">
                <Card className="border-border/70 bg-card/95 shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2.5 text-base">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300">
                        <IconUsers className="h-5 w-5" />
                      </span>
                      Interaction
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3 text-sm md:grid-cols-2">
                    <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Agent</div>
                      <div className="mt-1 font-medium">
                        {interaction?.first_name || interaction?.last_name
                          ? `${interaction.first_name || ""} ${interaction.last_name || ""}`.trim()
                          : interaction?.agent_username || "-"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Queue</div>
                      <div className="mt-1 font-medium">{interaction?.queue_name || "-"}</div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Customer</div>
                      <div className="mt-1 font-medium">
                        {interaction?.from_name || interaction?.from_number || "-"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Completed</div>
                      <div className="mt-1 font-medium">
                        {formatDateTime(interaction?.completed_at || interaction?.abandoned_at)}
                        <span className="ml-2 text-muted-foreground">
                          · {formatDuration(interaction?.talk_time_seconds)} talk
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-border/70 bg-card/95 shadow-sm">
                  <CardContent className="pt-6">
                    {recordingId || recordingUrl ? (
                      <RecordingPlayer src={recordingUrl} recordingId={recordingId} />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No recording available for this interaction.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-border/70 bg-card/95 shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2.5 text-base">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300">
                        <IconQuote className="h-5 w-5" />
                      </span>
                      Transcript
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {speakerTurns && speakerTurns.length > 0 ? (
                      <div className="max-h-[420px] space-y-4 overflow-y-auto pr-2" data-testid="quality-diarized-conversation">
                        {speakerTurns.map((turn, index) => {
                          const isRight = Number(turn.speaker) % 2 === 1;
                          const tone = isRight
                            ? { bubble: "bg-sky-600 text-white", avatar: "bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/40" }
                            : { bubble: "bg-emerald-600 text-white", avatar: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/40" };
                          return (
                            <div
                              key={index}
                              className={`flex w-full items-end gap-2 ${isRight ? "flex-row-reverse" : "flex-row"}`}
                            >
                              <div className={`flex size-8 shrink-0 items-center justify-center rounded-full border ${tone.avatar}`}>
                                {isRight ? <IconHeadset className="size-4" /> : <IconUser className="size-4" />}
                              </div>
                              <div className={`flex min-w-0 max-w-[85%] flex-col ${isRight ? "items-end" : "items-start"}`}>
                                <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                                  Speaker {Number(turn.speaker) + 1}
                                </div>
                                <div className={`rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                                  isRight ? `${tone.bubble} rounded-br-md` : "rounded-bl-md bg-muted text-foreground"
                                }`}>
                                  <p className="whitespace-pre-wrap leading-relaxed">{turn.text}</p>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : transcriptionText ? (
                      <p className="max-h-[420px] overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-relaxed">
                        {transcriptionText}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No transcript yet. Run the AI evaluation and the assistant will transcribe the
                        recording automatically.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Right column: scoring panel — scrolls independently of the recording */}
              <div className="min-h-0 space-y-4 xl:overflow-y-auto xl:pr-1">
                <Card className="border-border/70 bg-card/95 shadow-sm">
                  <CardContent className="space-y-4 p-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <IconGauge className="h-4 w-4 text-emerald-500" />
                        Score
                      </div>
                      <span className="text-2xl font-semibold tracking-tight">
                        {localScore.percent}%
                      </span>
                    </div>
                    <Progress value={localScore.percent} className="h-2" />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {localScore.total} / {localScore.max} pts
                      </span>
                      {localScore.criticalFailed ? (
                        <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                          <IconAlertTriangle className="h-3.5 w-3.5" />
                          Critical fail
                        </span>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="border-violet-500/50 text-violet-700 hover:bg-violet-500/10 dark:text-violet-300"
                        disabled={!canRunAi}
                        onClick={runAiEvaluation}
                        data-testid="evaluate-with-ai-button"
                      >
                        {aiRunning ? (
                          <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <IconRobot className="mr-2 h-4 w-4" />
                        )}
                        {aiRunning ? AI_PHASE_LABELS[aiPhase] || "Working…" : "Evaluate with AI"}
                      </Button>
                      <Button type="button" size="sm" variant="outline" disabled={isFinal || saving} onClick={() => save("save")}>
                        <IconDeviceFloppy className="mr-2 h-4 w-4" />
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="bg-emerald-600 text-white hover:bg-emerald-700"
                        disabled={isFinal || saving}
                        onClick={() => save("finalize")}
                      >
                        <IconRosetteDiscountCheck className="mr-2 h-4 w-4" />
                        Finalize
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {aiResult ? (
                  <Card className="border-violet-500/30 bg-card/95 shadow-sm">
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <IconRobot className="h-4 w-4 text-violet-500" />
                        AI assessment
                        <Badge variant="outline" className="ml-auto text-[11px] text-muted-foreground">
                          {aiResult.model}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      {aiResult.summary ? <p>{aiResult.summary}</p> : null}
                      {(aiResult.coachingTips || []).length > 0 ? (
                        <div>
                          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            <IconBolt className="h-3.5 w-3.5" />
                            Coaching tips
                          </div>
                          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                            {aiResult.coachingTips.map((tip, index) => (
                              <li key={index}>{tip}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {(aiResult.risks || []).length > 0 ? (
                        <div>
                          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                            <IconAlertTriangle className="h-3.5 w-3.5" />
                            Risks
                          </div>
                          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                            {aiResult.risks.map((risk, index) => (
                              <li key={index}>{risk}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                ) : null}

                {(schema.sections || []).map((section) => (
                  <Card key={section.id} className="border-border/70 bg-card/95 shadow-sm">
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <IconClipboardCheck className="h-4 w-4 text-muted-foreground" />
                        {section.title}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {(section.criteria || []).map((criterion) => {
                        const answer = answers[criterion.id];
                        return (
                          <div key={criterion.id} className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="text-sm font-medium">
                                  {criterion.label}
                                  {criterion.criticalFail ? (
                                    <Badge variant="outline" className="ml-2 border-red-500/40 text-[10px] text-red-600 dark:text-red-400">
                                      Critical
                                    </Badge>
                                  ) : null}
                                </div>
                                {criterion.description ? (
                                  <p className="mt-0.5 text-xs text-muted-foreground">{criterion.description}</p>
                                ) : null}
                              </div>
                              {answer?.source === "ai" && answer?.confidence != null ? (
                                <Badge variant="outline" className="shrink-0 border-violet-500/40 text-[10px] text-violet-700 dark:text-violet-300">
                                  AI {Math.round(answer.confidence * 100)}%
                                </Badge>
                              ) : null}
                            </div>
                            <ScoreButtons
                              criterion={criterion}
                              answer={answer}
                              disabled={isFinal}
                              onScore={(score) => setAnswer(criterion.id, { score, na: false })}
                            />
                            {answer?.reasoning ? (
                              <p className="text-xs text-muted-foreground">
                                <span className="font-medium text-foreground/70">Reasoning: </span>
                                {answer.reasoning}
                              </p>
                            ) : null}
                            {answer?.evidence ? (
                              <blockquote className="border-l-2 border-violet-500/50 pl-2 text-xs italic text-muted-foreground">
                                “{answer.evidence}”
                              </blockquote>
                            ) : null}
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                ))}

                <Card className="border-border/70 bg-card/95 shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <IconCircleCheck className="h-4 w-4 text-muted-foreground" />
                      Review notes
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Textarea
                      value={reviewNotes}
                      onChange={(event) => setReviewNotes(event.target.value)}
                      placeholder="Supervisor notes, coaching follow-ups, calibration remarks…"
                      rows={4}
                      disabled={isFinal}
                    />
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </section>
      </main>
    </SupervisorPageShell>
  );
}
