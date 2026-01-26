"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  SmilePlus,
  Frown,
  Minus,
  TrendingUp,
  MessageSquare,
  BookOpen,
  Sparkles,
  Target,
  Activity,
  FileText,
  Send,
  Volume2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { notify } from "@/components/ToastNotify";
import useActiveCallStore from "@/lib/stores/active-call-store";
import {
  getIntentLabel,
  getSentimentColor,
} from "@/lib/agent-assist/sentiment-analysis";

/**
 * AgentAssist Component
 * Displays real-time transcription, sentiment analysis, intent detection, and KB article suggestions
 */
export function AgentAssist({ interactionId, interaction }) {
  // Read transcriptions directly from active-call-store (same as demo portal)
  const transcriptions = useActiveCallStore((state) => state.transcriptions);
  const originalCallControlId = useActiveCallStore(
    (state) => state.originalCallControlId
  );

  // Debug: Log interaction data to help troubleshoot from_number issue
  useEffect(() => {
    // Interaction data loaded
  }, [interaction?.id, interaction?.from_number]);
  const [kbArticles, setKbArticles] = useState([]);
  const [isLoadingKb, setIsLoadingKb] = useState(false);
  const [selectedTranscription, setSelectedTranscription] = useState(null);
  const [selectedArticle, setSelectedArticle] = useState(null);
  const scrollRef = useRef(null);

  // Auto-scroll to bottom when new transcriptions arrive
  useEffect(() => {
    if (scrollRef.current) {
      const viewport = scrollRef.current.querySelector(
        "[data-radix-scroll-area-viewport]"
      );
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
  }, [transcriptions]);

  // Calculate aggregate sentiment and intent
  const aggregateStats = calculateAggregateStats(transcriptions);

  // Search KB articles based on selected transcription's intent
  // All KB articles are shared among all users - no filtering needed
  async function searchKbArticles(intent) {
    if (!intent || intent.toLowerCase() === "general inquiry") {
      setKbArticles([]);
      return;
    }

    setIsLoadingKb(true);
    try {
      const url = new URL(
        "/api/contact-center/kb-articles/search",
        window.location.origin
      );
      url.searchParams.set("q", intent);
      url.searchParams.set("pageSize", "5");
      url.searchParams.set("status", "Published");

      const response = await fetch(url.toString(), {
        credentials: "include",
      });

      if (response.ok) {
        const data = await response.json();
        setKbArticles(data.rows || []);
      } else {
        console.error(
          "KB articles search failed:",
          response.status,
          await response.text()
        );
        setKbArticles([]);
      }
    } catch (err) {
      console.error("Failed to search KB articles:", err);
      setKbArticles([]);
    } finally {
      setIsLoadingKb(false);
    }
  }

  // Handle transcription selection
  const handleTranscriptionClick = (transcription) => {
    setSelectedTranscription(transcription);
    setSelectedArticle(null);
    if (transcription.intent) {
      searchKbArticles(transcription.intent);
    }
  };

  // Handle article selection
  const handleArticleClick = (article) => {
    setSelectedArticle(article);
  };

  const handleSendSMS = async (customMessageBody = null) => {
    // Get caller number from interaction (try multiple field names)
    const callerNumber =
      interaction?.from_number || interaction?.fromNumber || interaction?.from;

    if (!callerNumber) {
      notify({
        title: "Cannot send SMS",
        description: "Missing caller number",
        variant: "error",
      });
      return;
    }

    // If customMessageBody is provided (from LLM), use it; otherwise require article
    if (!customMessageBody && !selectedArticle) {
      notify({
        title: "Cannot send SMS",
        description:
          "No content to send. Select an article or enable LLM to generate a response.",
        variant: "error",
      });
      return;
    }

    try {
      let messageBody = customMessageBody;

      if (!messageBody) {
        // Use article content if no custom message provided
        const title = stripMarkdown(selectedArticle.title || "");
        const summary = stripMarkdown(selectedArticle.summary || "");
        const content = stripMarkdown(selectedArticle.content || "");

        messageBody = title;
        if (summary) {
          messageBody += `\n\n${summary}`;
        }
        if (content) {
          const remainingLength = 1600 - messageBody.length - 10;
          if (remainingLength > 0) {
            messageBody += `\n\n${content.substring(0, remainingLength)}`;
            if (content.length > remainingLength) {
              messageBody += "...";
            }
          }
        }
      } else {
        // Strip markdown from custom message
        messageBody = stripMarkdown(messageBody);
      }

      if (messageBody.length > 1600) {
        messageBody = messageBody.substring(0, 1600) + "...";
      }

      const response = await fetch("/api/messaging/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          to: callerNumber,
          body: messageBody,
          type: "SMS",
        }),
      });

      const data = await response.json();

      if (response.ok && data.ok) {
        notify({
          title: "SMS sent successfully",
          description: `Message sent to ${callerNumber}`,
          variant: "success",
        });
      } else {
        notify({
          title: "Failed to send SMS",
          description: data.error || "Unknown error",
          variant: "error",
        });
      }
    } catch (error) {
      console.error("Error sending SMS:", error);
      notify({
        title: "Failed to send SMS",
        description: error.message || "Network error",
        variant: "error",
      });
    }
  };

  const handleSpeak = async (customSpeakText = null) => {
    if (!originalCallControlId) {
      notify({
        title: "Cannot play content",
        description: "No active call",
        variant: "error",
      });
      return;
    }

    // If customSpeakText is provided (from LLM), use it; otherwise require article
    if (!customSpeakText && !selectedArticle) {
      notify({
        title: "Cannot play content",
        description:
          "No content to play. Select an article or enable LLM to generate a response.",
        variant: "error",
      });
      return;
    }

    try {
      let speakText = customSpeakText;

      if (!speakText) {
        // Use article content if no custom text provided
        const title = stripMarkdown(selectedArticle.title || "");
        const summary = stripMarkdown(selectedArticle.summary || "");
        const content = stripMarkdown(selectedArticle.content || "");

        speakText = title;
        if (summary) {
          speakText += `. ${summary}`;
        }
        if (content) {
          speakText += `. ${content}`;
        }
      } else {
        // Strip markdown from custom text
        speakText = stripMarkdown(speakText);
      }

      if (speakText.length > 5000) {
        speakText = speakText.substring(0, 5000) + "...";
      }

      const response = await fetch("/api/voice/call-action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          action: "speak",
          callControlId: originalCallControlId,
          params: {
            payload: speakText,
            voice: "Telnyx.NaturalHD.astra",
            stop: "all",
          },
        }),
      });

      const data = await response.json();

      if (response.ok && data.ok) {
        notify({
          title: "Article is being played",
          description: "Reading article content to caller",
          variant: "success",
        });
      } else {
        notify({
          title: "Failed to play article",
          description: data.error || "Unknown error",
          variant: "error",
        });
      }
    } catch (error) {
      console.error("Error playing article:", error);
      notify({
        title: "Failed to play article",
        description: error.message || "Network error",
        variant: "error",
      });
    }
  };

  return (
    <div className="flex flex-col h-full gap-3 px-4 overflow-hidden pb-4">
      {/* Top Stats Cards */}
      <div className="grid grid-cols-3 gap-3 flex-shrink-0">
        {/* Intent Card */}
        <Card className="border-2 border-border bg-card">
          <CardContent className="pl-5">
            <h3 className="text-lg font-semibold mb-2">Detected Intent</h3>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2.5 rounded-lg bg-purple-500/10">
                <Target className="h-7 w-7 text-purple-500" />
              </div>
              <div className="flex-1 min-w-0">
                {aggregateStats.topIntent ? (
                  <>
                    <Badge className="bg-purple-500 text-white hover:bg-purple-600 text-sm px-3 py-1">
                      {getIntentLabel(aggregateStats.topIntent)}
                    </Badge>
                    <p className="text-xs text-muted-foreground mt-1">
                      {aggregateStats.intentCount} detection(s)
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Waiting for transcription...
                  </p>
                )}
              </div>
            </div>
            {aggregateStats.topTags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {aggregateStats.topTags.map((tag, idx) => (
                  <Badge
                    key={idx}
                    variant="outline"
                    className="text-[10px] px-1.5 py-0.5 border-green-500 text-green-500 bg-transparent"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Current Sentiment Card */}
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
                    {aggregateStats.currentScore}%
                  </span>
                </div>
                <Badge
                  className={`text-white hover:opacity-90 text-xs px-2 py-0.5 mt-1 ${getSentimentBadgeColorSolid(
                    aggregateStats.currentSentiment
                  )}`}
                >
                  {aggregateStats.currentSentiment}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Average Sentiment Card */}
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
                    {aggregateStats.averageScore}%
                  </span>
                </div>
                <Badge
                  className={`text-white hover:opacity-90 text-xs px-2 py-0.5 mt-1 ${getSentimentBadgeColorSolid(
                    aggregateStats.averageSentiment
                  )}`}
                >
                  {aggregateStats.averageSentiment}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Area - 3 Equal Column Layout */}
      <div className="grid grid-cols-3 gap-3 flex-1 min-h-0 overflow-hidden mt-3">
        {/* Column 1: Transcription Chat View */}
        <Card className="col-span-1 flex flex-col border-2 border-border bg-card overflow-hidden">
          <CardContent className="p-0 flex flex-col h-full overflow-hidden">
            <div className="px-4 pb-6 border-b border-border flex-shrink-0">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-green-500" />
                Live Transcription
                <Badge className="ml-auto text-xs bg-green-500/10 text-green-500 border-green-500/50">
                  {transcriptions.length}
                </Badge>
              </h3>
            </div>
            <ScrollArea className="flex-1 overflow-y-auto" ref={scrollRef}>
              {transcriptions.length === 0 ? (
                <div className="flex items-center justify-center py-8 px-3">
                  <div className="text-center text-muted-foreground">
                    <MessageSquare className="h-10 w-10 mx-auto mb-2 opacity-30" />
                    <p className="text-xs">Waiting for transcription...</p>
                  </div>
                </div>
              ) : (
                <div className="p-3 space-y-2">
                  {transcriptions.map((t, idx) => (
                    <TranscriptionBubble
                      key={t.id || idx}
                      transcription={t}
                      isSelected={selectedTranscription?.id === t.id}
                      onClick={() => handleTranscriptionClick(t)}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Column 2: KB Articles List */}
        <Card className="col-span-1 flex flex-col border-2 border-border bg-card overflow-hidden h-full">
          <CardContent className="p-0 flex flex-col h-full overflow-hidden">
            <div className="px-4 pb-6 border-b border-border flex-shrink-0">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <BookOpen className="h-5 w-5 text-amber-500" />
                  Suggested Articles
                  <Sparkles className="h-4 w-4 ml-auto text-amber-500" />
                </h3>
              </div>
            </div>
            <ScrollArea className="flex-1 overflow-y-auto">
              <div className="p-3">
                {!selectedTranscription ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="text-center text-muted-foreground">
                      <BookOpen className="h-10 w-10 mx-auto mb-2 opacity-30" />
                      <p className="text-xs">
                        Select a transcription to see articles
                      </p>
                    </div>
                  </div>
                ) : isLoadingKb ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="text-center text-muted-foreground">
                      <div className="animate-spin h-8 w-8 border-4 border-amber-500 border-t-transparent rounded-full mx-auto mb-2" />
                      <p className="text-xs">Searching...</p>
                    </div>
                  </div>
                ) : kbArticles.length > 0 ? (
                  <div className="space-y-1.5">
                    {kbArticles.map((article, idx) => (
                      <KbArticleCard
                        key={article.slug || idx}
                        article={article}
                        isSelected={selectedArticle?.slug === article.slug}
                        onSelect={() => handleArticleClick(article)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-8">
                    <div className="text-center text-muted-foreground">
                      <BookOpen className="h-10 w-10 mx-auto mb-2 opacity-30" />
                      <p className="text-xs">No articles found</p>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Column 3: Article Viewer / LLM Response */}
        <Card className="col-span-1 flex flex-col border-2 border-border bg-card overflow-hidden h-full">
          <CardContent className="p-0 flex flex-col h-full overflow-hidden">
            <ArticleViewer
              article={selectedArticle}
              transcription={selectedTranscription}
              interaction={interaction}
              callControlId={originalCallControlId}
              onSendSMS={handleSendSMS}
              onSpeak={handleSpeak}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Transcription Bubble Component
 */
function TranscriptionBubble({ transcription, isSelected, onClick }) {
  const isInbound = transcription.track === "inbound";

  return (
    <div className="w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div
        className={`rounded-lg p-3 border-2 bg-card cursor-pointer transition-all hover:shadow-md ${
          isSelected
            ? "border-green-500 shadow-md ring-2 ring-green-500/20"
            : "border-border hover:border-green-500/50"
        }`}
        onClick={onClick}
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
          <span className="text-xs text-muted-foreground ml-auto">
            {new Date(transcription.timestamp).toLocaleTimeString()}
          </span>
        </div>

        <p className="text-sm leading-relaxed mb-2">
          {transcription.transcript}
        </p>

        {transcription.tags && transcription.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {transcription.tags.map((tag, idx) => (
              <Badge
                key={idx}
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

/**
 * KB Article Card Component
 */
function KbArticleCard({ article, isSelected, onSelect }) {
  const getPreviewText = () => {
    if (article.summary) return article.summary;
    if (article.content) {
      const plainText = article.content
        .replace(/[#*_`\[\]]/g, "")
        .replace(/\n+/g, " ")
        .trim();
      return (
        plainText.substring(0, 150) + (plainText.length > 150 ? "..." : "")
      );
    }
    return "No preview available";
  };

  return (
    <Card
      className={`cursor-pointer transition-all hover:shadow-md bg-card ${
        isSelected
          ? "border-2 border-amber-500 shadow-md ring-2 ring-amber-500/20"
          : "border border-border hover:border-amber-500/50"
      }`}
      onClick={onSelect}
    >
      <CardContent className="px-4 py-0">
        <div className="space-y-1.5">
          {article.category && (
            <Badge
              variant="outline"
              className="text-xs bg-amber-500/10 text-amber-500 border-amber-500/50"
            >
              {article.category}
            </Badge>
          )}

          <h4 className="font-semibold text-sm leading-tight">
            {article.title}
          </h4>

          <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
            {getPreviewText()}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Article Viewer Component
 */
function ArticleViewer({
  article,
  transcription,
  interaction,
  callControlId,
  onSendSMS,
  onSpeak,
}) {
  const [useLLM, setUseLLM] = useState(false);
  const [llmResponse, setLlmResponse] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);

  // Get caller number from interaction (try multiple field names)
  const callerNumber =
    interaction?.from_number || interaction?.fromNumber || interaction?.from;

  // Caller number detection
  useEffect(() => {
    // Caller number detected
  }, [interaction?.id, interaction?.from_number, callerNumber]);

  const generateLLMResponse = useCallback(async () => {
    if (!transcription) return;

    setIsGenerating(true);
    setLlmResponse("");

    try {
      const response = await fetch("/api/agent-assist/generate-response", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          transcript: transcription.transcript,
          articleContent: article?.content || null, // Article is optional
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to generate response");
      }

      // Handle streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;

            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                accumulatedText += parsed.content;
                setLlmResponse(accumulatedText);
              }
            } catch (e) {
              // Ignore parsing errors
            }
          }
        }
      }
    } catch (error) {
      console.error("Error generating LLM response:", error);
      notify({
        title: "Failed to generate response",
        description: error.message || "Network error",
        variant: "error",
      });
    } finally {
      setIsGenerating(false);
    }
  }, [transcription, article]);

  // Auto-generate LLM response when transcription is selected and LLM is enabled
  // LLM can work with just transcription (article is optional)
  useEffect(() => {
    if (useLLM && transcription) {
      generateLLMResponse();
    } else if (!useLLM) {
      setLlmResponse("");
    }
  }, [useLLM, transcription?.id, generateLLMResponse]);

  const handleLLMToggle = (checked) => {
    setUseLLM(checked);
  };

  // Display logic:
  // - If LLM is enabled: show LLM response (even if no article)
  // - If LLM is disabled and article exists: show article content
  // - If LLM is disabled and no article: show message
  const displayContent = useLLM
    ? llmResponse || ""
    : article
    ? article.content || "No content available"
    : "Select an article to view content";
  const isContentLoading = useLLM && isGenerating;

  return (
    <>
      {/* Fixed Header */}
      <div className="px-4 pb-6 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <FileText className="h-5 w-5 text-blue-500" />
            {useLLM && llmResponse
              ? "AI Generated Response"
              : article
              ? "Article Content"
              : "Content"}
          </h3>
          <div className="flex items-center gap-2">
            <Switch
              id="use-llm"
              checked={useLLM}
              onCheckedChange={handleLLMToggle}
              disabled={!transcription}
            />
            <Label
              htmlFor="use-llm"
              className="text-xs cursor-pointer text-muted-foreground"
            >
              Use LLM
            </Label>
          </div>
        </div>
      </div>

      {/* Scrollable Content Section */}
      <ScrollArea className="flex-1 overflow-y-auto">
        <div className="px-4 py-4">
          {isContentLoading && !llmResponse ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-center text-muted-foreground">
                <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-2" />
                <p className="text-xs">Generating response...</p>
              </div>
            </div>
          ) : (
            <div className="prose prose-xs dark:prose-invert max-w-none break-words [&_*]:break-words">
              {useLLM ? (
                <ReactMarkdown
                  components={{
                    h1: ({ node, ...props }) => (
                      <h1
                        className="text-base font-bold mb-3 text-green-500"
                        {...props}
                      />
                    ),
                    h2: ({ node, ...props }) => (
                      <h2
                        className="text-sm font-bold mb-2 text-green-500"
                        {...props}
                      />
                    ),
                    p: ({ node, ...props }) => (
                      <p className="text-xs leading-relaxed mb-2" {...props} />
                    ),
                    ul: ({ node, ...props }) => (
                      <ul
                        className="list-disc list-inside mb-2 text-xs"
                        {...props}
                      />
                    ),
                    ol: ({ node, ...props }) => (
                      <ol
                        className="list-decimal list-inside mb-2 text-xs"
                        {...props}
                      />
                    ),
                    li: ({ node, ...props }) => (
                      <li className="mb-1" {...props} />
                    ),
                    strong: ({ node, ...props }) => (
                      <strong className="font-bold" {...props} />
                    ),
                  }}
                >
                  {displayContent}
                </ReactMarkdown>
              ) : article ? (
                <>
                  <h1 className="text-base font-bold mb-3 text-green-500">
                    {article.title}
                  </h1>
                  {article.summary && (
                    <p className="text-sm mb-3 leading-relaxed text-muted-foreground">
                      {article.summary}
                    </p>
                  )}
                  <ReactMarkdown
                    components={{
                      h1: ({ node, ...props }) => (
                        <h1
                          className="text-base font-bold mb-3 text-green-500"
                          {...props}
                        />
                      ),
                      h2: ({ node, ...props }) => (
                        <h2
                          className="text-sm font-bold mb-2 text-green-500"
                          {...props}
                        />
                      ),
                      h3: ({ node, ...props }) => (
                        <h3
                          className="text-xs font-bold mb-2 text-green-500"
                          {...props}
                        />
                      ),
                      p: ({ node, ...props }) => (
                        <p
                          className="text-xs leading-relaxed mb-2"
                          {...props}
                        />
                      ),
                      ul: ({ node, ...props }) => (
                        <ul
                          className="list-disc list-inside mb-2 text-xs space-y-1 ml-2"
                          {...props}
                        />
                      ),
                      ol: ({ node, ...props }) => (
                        <ol
                          className="list-decimal list-inside mb-2 text-xs space-y-1 ml-2"
                          {...props}
                        />
                      ),
                      li: ({ node, ...props }) => (
                        <li className="mb-1" {...props} />
                      ),
                      strong: ({ node, ...props }) => (
                        <strong className="font-bold" {...props} />
                      ),
                      em: ({ node, ...props }) => (
                        <em className="italic" {...props} />
                      ),
                      code: ({ node, ...props }) => (
                        <code
                          className="bg-muted px-1 py-0.5 rounded text-xs font-mono"
                          {...props}
                        />
                      ),
                      pre: ({ node, ...props }) => (
                        <pre
                          className="bg-muted p-2 rounded text-xs font-mono overflow-x-auto mb-2"
                          {...props}
                        />
                      ),
                      blockquote: ({ node, ...props }) => (
                        <blockquote
                          className="border-l-2 border-green-500 pl-2 italic text-muted-foreground mb-2"
                          {...props}
                        />
                      ),
                    }}
                  >
                    {convertPlainTextToMarkdown(article.content || "")}
                  </ReactMarkdown>
                </>
              ) : (
                <div className="text-center text-muted-foreground py-8">
                  <p className="text-sm">Select an article to view content</p>
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="px-4 pt-4 border-t bg-muted/10 flex-shrink-0">
        <div className="grid grid-cols-2 gap-2">
          <Button
            className="w-full h-10 bg-blue-600 hover:bg-blue-700 text-white border-0 rounded-lg"
            onClick={() => {
              // Update handleSendSMS to use LLM response if enabled
              if (useLLM && llmResponse) {
                const messageBody = stripMarkdown(llmResponse);
                onSendSMS(messageBody);
              } else {
                onSendSMS();
              }
            }}
            disabled={!callerNumber || callerNumber.trim() === ""}
          >
            <Send className="h-6 w-6 mr-2" />
            Send SMS
          </Button>
          <Button
            className="w-full h-10 bg-green-500 hover:bg-green-600 text-white border-0 rounded-lg"
            onClick={() => {
              // Update handleSpeak to use LLM response if enabled
              if (useLLM && llmResponse) {
                const speakText = stripMarkdown(llmResponse);
                onSpeak(speakText);
              } else if (article) {
                onSpeak();
              }
            }}
            disabled={!callControlId || (!useLLM && !article)}
          >
            <Volume2 className="h-6 w-6 mr-2" />
            {useLLM ? "Speak Response" : "Speak Article"}
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * Helper functions
 */
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

function calculateAggregateStats(transcriptions) {
  if (transcriptions.length === 0) {
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
  const currentScore = latest.sentimentScore || 50;

  const scores = transcriptions
    .filter((t) => t.sentimentScore != null)
    .map((t) => t.sentimentScore);

  const averageScore =
    scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 50;

  let averageSentiment = "neutral";
  if (averageScore > 60) {
    averageSentiment = "positive";
  } else if (averageScore < 40) {
    averageSentiment = "negative";
  }

  let topIntent = null;
  let intentCount = 0;

  for (let i = transcriptions.length - 1; i >= 0; i--) {
    if (transcriptions[i].intent) {
      topIntent = transcriptions[i].intent;
      intentCount = transcriptions.filter((t) => t.intent === topIntent).length;
      break;
    }
  }

  let topTags = [];
  for (let i = transcriptions.length - 1; i >= 0; i--) {
    if (
      transcriptions[i].tags &&
      Array.isArray(transcriptions[i].tags) &&
      transcriptions[i].tags.length > 0
    ) {
      topTags = transcriptions[i].tags.slice(0, 3);
      break;
    }
  }

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

/**
 * Convert plain text content to markdown format for better rendering
 * Handles numbered lists and bullet points that are in plain text format
 */
function convertPlainTextToMarkdown(text) {
  if (!text) return "";

  // Split into lines
  const lines = text.split("\n");
  const result = [];
  let inNumberedList = false;
  let inBulletList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if line is a numbered list item (starts with number and period)
    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      if (inBulletList) {
        result.push(""); // Add blank line before switching to numbered list
        inBulletList = false;
      }
      if (!inNumberedList && i > 0 && lines[i - 1].trim() !== "") {
        result.push(""); // Add blank line before numbered list
      }
      result.push(trimmed); // Keep numbered list as-is (markdown compatible)
      inNumberedList = true;
      continue;
    }

    // Check if line is a bullet point (starts with dash, possibly indented)
    const bulletMatch = line.match(/^(\s*)-\s+(.+)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1];
      const content = bulletMatch[2];
      if (inNumberedList) {
        result.push(""); // Add blank line before switching to bullet list
        inNumberedList = false;
      }
      if (!inBulletList && i > 0 && lines[i - 1].trim() !== "") {
        result.push(""); // Add blank line before bullet list
      }
      // Preserve indentation for nested bullets, but ensure proper markdown format
      result.push(`${indent}- ${content}`);
      inBulletList = true;
      continue;
    }

    // Regular line - preserve as-is
    if (trimmed === "") {
      if (inNumberedList || inBulletList) {
        result.push(""); // Add blank line after list
        inNumberedList = false;
        inBulletList = false;
      } else {
        result.push("");
      }
    } else {
      // End of list if we hit a non-list line
      if (inNumberedList || inBulletList) {
        if (!trimmed.match(/^(\d+)\./) && !line.match(/^(\s*)-/)) {
          inNumberedList = false;
          inBulletList = false;
        }
      }
      result.push(line);
    }
  }

  return result.join("\n");
}

function stripMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/>\s+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
