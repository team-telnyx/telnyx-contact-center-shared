"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MessageSquare,
  TrendingUp,
  Activity,
  Target,
  Hash,
  SmilePlus,
  Frown,
  Minus,
} from "lucide-react";
import { getIntentLabel } from "@/lib/agent-assist/sentiment-analysis";

function getSentimentBadgeColor(sentiment) {
  switch (sentiment) {
    case "positive":
      return "bg-green-500/10 text-green-500 border-green-500/50";
    case "negative":
      return "bg-red-500/10 text-red-500 border-red-500/50";
    default:
      return "bg-blue-500/10 text-blue-500 border-blue-500/50";
  }
}

function getSentimentBadgeColorSolid(sentiment) {
  switch (sentiment) {
    case "positive":
      return "bg-green-500";
    case "negative":
      return "bg-red-500";
    default:
      return "bg-blue-500";
  }
}

function getSentimentIcon(sentiment) {
  const iconProps = { className: "h-3 w-3" };
  switch (sentiment) {
    case "positive":
      return <SmilePlus {...iconProps} />;
    case "negative":
      return <Frown {...iconProps} />;
    default:
      return <Minus {...iconProps} />;
  }
}

function formatSttConfidencePercent(confidence) {
  if (confidence === null || confidence === undefined || confidence === "") return null;
  const numeric = typeof confidence === "number" ? confidence : Number(confidence);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.min(1, Math.max(0, numeric)) * 100);
}

function calculateSummary(transcriptions) {
  if (!Array.isArray(transcriptions) || transcriptions.length === 0) {
    return {
      topIntent: null,
      intentCount: 0,
      topTags: [],
      currentSentiment: "neutral",
      currentScore: 50,
      averageSentiment: "neutral",
      averageScore: 50,
    };
  }

  const latest = transcriptions[transcriptions.length - 1];
  const currentSentiment = latest.sentiment || "neutral";
  const currentScore =
    typeof latest.sentimentScore === "number" ? latest.sentimentScore : 50;

  const scores = transcriptions
    .map((t) => t.sentimentScore)
    .filter((v) => typeof v === "number");
  const averageScore =
    scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 50;
  let averageSentiment = "neutral";
  if (averageScore > 60) averageSentiment = "positive";
  if (averageScore < 40) averageSentiment = "negative";

  const intentCounts = new Map();
  const tagCounts = new Map();
  for (const item of transcriptions) {
    if (item.intent) {
      intentCounts.set(item.intent, (intentCounts.get(item.intent) || 0) + 1);
    }
    if (Array.isArray(item.tags)) {
      for (const tag of item.tags) {
        if (!tag) continue;
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }

  let topIntent = null;
  let intentCount = 0;
  for (const [intent, count] of intentCounts.entries()) {
    if (count > intentCount) {
      intentCount = count;
      topIntent = intent;
    }
  }

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  return {
    topIntent,
    intentCount,
    topTags,
    currentSentiment,
    currentScore,
    averageSentiment,
    averageScore,
  };
}

function TranscriptionBubble({ transcription }) {
  const isInbound = transcription.track === "inbound";
  const sttConfidencePercent = formatSttConfidencePercent(transcription.confidence);

  return (
    <div className="w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div
        className={`rounded-lg p-3 border-2 bg-card transition-all ${
          isInbound ? "border-green-500/40" : "border-blue-500/40"
        }`}
      >
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          {transcription.sentiment && (
            <Badge
              variant="outline"
              className={`text-xs ${getSentimentBadgeColor(
                transcription.sentiment
              )}`}
            >
              {getSentimentIcon(transcription.sentiment)}
              <span className="ml-1 capitalize">{transcription.sentiment}</span>
            </Badge>
          )}
          {transcription.intent && (
            <Badge
              variant="outline"
              className="text-xs bg-purple-500/10 text-purple-500 border-purple-500/50"
            >
              <Target className="h-3 w-3 mr-1" />
              {getIntentLabel(transcription.intent)}
            </Badge>
          )}
          {sttConfidencePercent !== null && (
            <Badge
              variant="outline"
              className="text-xs bg-cyan-500/10 text-cyan-500 border-cyan-500/50"
              title="Speech-to-text recognition confidence from Telnyx Standalone STT"
            >
              <Activity className="h-3 w-3 mr-1" />
              STT Confidence {sttConfidencePercent}%
            </Badge>
          )}
          <span className="text-xs text-muted-foreground ml-auto">
            {transcription.timestamp
              ? new Date(transcription.timestamp).toLocaleTimeString()
              : "-"}
          </span>
        </div>

        <p className="text-sm leading-relaxed mb-2">
          {transcription.transcript}
        </p>

        {Array.isArray(transcription.tags) && transcription.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {transcription.tags.map((tag, idx) => (
              <Badge
                key={`${tag}-${idx}`}
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 border-green-500 text-green-500 bg-transparent"
              >
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TranscriptionHistory({ transcriptions = [] }) {
  const summary = calculateSummary(transcriptions);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Card className="border-2 border-border bg-card">
          <CardContent className="pl-5">
            <h3 className="text-lg font-semibold mb-2">Current Sentiment</h3>
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-blue-500/10">
                <Activity className="h-7 w-7 text-blue-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-foreground leading-none">
                    {summary.currentScore}%
                  </span>
                </div>
                <Badge
                  className={`text-white hover:opacity-90 text-xs px-2 py-0.5 mt-1 ${getSentimentBadgeColorSolid(
                    summary.currentSentiment
                  )}`}
                >
                  {summary.currentSentiment}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-2 border-border bg-card">
          <CardContent className="pl-5">
            <h3 className="text-lg font-semibold mb-2">Average Sentiment</h3>
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-green-500/10">
                <TrendingUp className="h-7 w-7 text-green-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-foreground leading-none">
                    {summary.averageScore}%
                  </span>
                </div>
                <Badge
                  className={`text-white hover:opacity-90 text-xs px-2 py-0.5 mt-1 ${getSentimentBadgeColorSolid(
                    summary.averageSentiment
                  )}`}
                >
                  {summary.averageSentiment}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-2 border-border bg-card">
          <CardContent className="pl-5">
            <h3 className="text-lg font-semibold mb-2">Top Intent</h3>
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-purple-500/10">
                <Target className="h-7 w-7 text-purple-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">
                  {summary.topIntent ? getIntentLabel(summary.topIntent) : "—"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {summary.intentCount ? `${summary.intentCount} mentions` : ""}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-2 border-border bg-card">
          <CardContent className="pl-5">
            <h3 className="text-lg font-semibold mb-2">Top Tags</h3>
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-amber-500/10">
                <Hash className="h-7 w-7 text-amber-500" />
              </div>
              <div className="flex flex-wrap gap-1">
                {summary.topTags.length > 0 ? (
                  summary.topTags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="outline"
                      className="text-xs border-amber-500 text-amber-500"
                    >
                      {tag}
                    </Badge>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-2 border-border bg-card overflow-hidden">
        <CardContent className="p-0 flex flex-col h-full overflow-hidden">
          <div className="px-4 pb-6 border-b border-border flex-shrink-0">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-green-500" />
              Transcription History
              <Badge className="ml-auto text-xs bg-green-500/10 text-green-500 border-green-500/50">
                {transcriptions.length}
              </Badge>
            </h3>
          </div>
          <ScrollArea className="flex-1 max-h-[420px] overflow-y-auto">
            {transcriptions.length === 0 ? (
              <div className="flex items-center justify-center py-8 px-3">
                <div className="text-center text-muted-foreground">
                  <MessageSquare className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  <p className="text-xs">No transcription available.</p>
                </div>
              </div>
            ) : (
              <div className="p-3 space-y-2">
                {transcriptions.map((t, idx) => (
                  <TranscriptionBubble key={t.id || idx} transcription={t} />
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

