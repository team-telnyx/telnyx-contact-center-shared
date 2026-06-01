"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CheckCircle,
  Circle,
  SkipForward,
  MessageSquare,
  HelpCircle,
  Tag,
  FormInput,
  Loader2,
} from "lucide-react";
import useWorkflowStore from "@/lib/stores/workflow-store";

/**
 * WorkflowChecklist Component
 * 
 * Displays the checklist of items for the current stage.
 * Shows completion status, allows manual completion/skip.
 */
export function WorkflowChecklist() {
  const {
    stages,
    currentStageIndex,
    itemStatuses,
    slotsFilled,
    isAnalyzing,
    completeItem,
    skipItem,
  } = useWorkflowStore();

  const currentStage = stages[currentStageIndex];
  const items = currentStage?.items || [];

  return (
    <Card className="border-2 border-border bg-card h-full flex flex-col">
      <CardHeader className="pb-3 flex-shrink-0">
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-purple-500" />
          {currentStage?.name || "Checklist"}
          {isAnalyzing && (
            <Badge variant="outline" className="ml-auto animate-pulse bg-purple-500/10 text-purple-500 border-purple-500/50">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Analyzing...
            </Badge>
          )}
        </CardTitle>
        {currentStage?.description && (
          <p className="text-xs text-muted-foreground">{currentStage.description}</p>
        )}
      </CardHeader>
      
      <CardContent className="flex-1 min-h-0 p-0">
        <ScrollArea className="h-full px-4 pb-4">
          <div className="space-y-2">
            {items.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <Circle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No items in this stage</p>
              </div>
            ) : (
              items.map((item) => (
                <WorkflowChecklistItem
                  key={item.id}
                  item={item}
                  status={itemStatuses[item.id] || { status: "pending" }}
                  slotValue={item.slot_name ? slotsFilled[item.slot_name] : null}
                  onComplete={completeItem}
                  onSkip={skipItem}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/**
 * Individual checklist item
 */
function WorkflowChecklistItem({ item, status, slotValue, onComplete, onSkip }) {
  const resolvedInitial = slotValue || status?.extracted_value || "";
  const [inputValue, setInputValue] = useState(resolvedInitial);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isCompleted = status.status === "completed";
  const isSkipped = status.status === "skipped";
  const isSuggested = status.status === "suggested";
  const isPending = status.status === "pending" || (!isCompleted && !isSkipped && !isSuggested);
  const isSlot = item.type === "slot";
  // slotsFilled is only written for completed items; medium-confidence
  // suggestions carry their value on the item status instead.
  const resolvedValue = slotValue || status.extracted_value;

  const handleComplete = async (value = null) => {
    setIsSubmitting(true);
    try {
      await onComplete(item.id, value);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSkip = async () => {
    setIsSubmitting(true);
    try {
      await onSkip(item.id);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getTypeIcon = () => {
    switch (item.type) {
      case "action":
        return <MessageSquare className="h-4 w-4" />;
      case "question":
        return <HelpCircle className="h-4 w-4" />;
      case "topic":
        return <Tag className="h-4 w-4" />;
      case "slot":
        return <FormInput className="h-4 w-4" />;
      default:
        return <Circle className="h-4 w-4" />;
    }
  };

  const getTypeBadgeColor = () => {
    switch (item.type) {
      case "action":
        return "bg-blue-500/10 text-blue-500 border-blue-500/50";
      case "question":
        return "bg-amber-500/10 text-amber-500 border-amber-500/50";
      case "topic":
        return "bg-green-500/10 text-green-500 border-green-500/50";
      case "slot":
        return "bg-purple-500/10 text-purple-500 border-purple-500/50";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <div
      className={`
        p-3 rounded-lg border-2 transition-all
        ${isCompleted ? "border-green-500/50 bg-green-500/5" : ""}
        ${isSkipped ? "border-muted bg-muted/30 opacity-60" : ""}
        ${isSuggested ? "border-amber-500/50 bg-amber-500/5" : ""}
        ${isPending ? "border-border bg-card hover:border-purple-500/30" : ""}
      `}
    >
      <div className="flex items-start gap-3">
        {/* Status Icon */}
        <button
          onClick={() => !isCompleted && !isSkipped && handleComplete(isSlot ? inputValue : null)}
          disabled={isCompleted || isSkipped || isSubmitting}
          className={`
            mt-0.5 flex-shrink-0 transition-colors
            ${isCompleted ? "text-green-500" : ""}
            ${isSkipped ? "text-muted-foreground" : ""}
            ${isSuggested ? "text-amber-500 hover:text-green-500" : ""}
            ${isPending ? "text-muted-foreground hover:text-purple-500" : ""}
          `}
        >
          {isCompleted ? (
            <CheckCircle className="h-5 w-5" />
          ) : isSubmitting ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : isSuggested ? (
            <CheckCircle className="h-5 w-5 opacity-60" />
          ) : (
            <Circle className="h-5 w-5" />
          )}
        </button>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className={`text-xs ${getTypeBadgeColor()}`}>
              {getTypeIcon()}
              <span className="ml-1 capitalize">{item.type}</span>
            </Badge>
            
            {status.confidence_score && (
              <Badge
                variant="outline"
                className={`text-xs ${
                  status.confidence_score >= 0.85
                    ? "bg-green-500/10 text-green-500 border-green-500/50"
                    : "bg-amber-500/10 text-amber-500 border-amber-500/50"
                }`}
              >
                LLM {Math.round(status.confidence_score * 100)}%
              </Badge>
            )}

            {isSuggested && (
              <Badge
                variant="outline"
                className="text-xs bg-amber-500/10 text-amber-500 border-amber-500/50"
              >
                Suggested
              </Badge>
            )}
          </div>

          <p
            className={`
              text-sm leading-relaxed
              ${isCompleted ? "line-through text-muted-foreground" : ""}
              ${isSkipped ? "line-through text-muted-foreground" : ""}
            `}
          >
            {item.label}
          </p>

          {/* Slot input field — editable while pending or suggested */}
          {isSlot && (isPending || isSuggested) && (
            <div className="mt-2 flex items-center gap-2">
              <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder={`Enter ${item.slot_name || "value"}...`}
                className="h-8 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && inputValue.trim()) {
                    handleComplete(inputValue.trim());
                  }
                }}
              />
              <Button
                size="sm"
                variant={isSuggested ? "default" : "secondary"}
                onClick={() => handleComplete(inputValue.trim())}
                disabled={!inputValue.trim() || isSubmitting}
                className="h-8"
              >
                {isSuggested ? "Accept" : "Save"}
              </Button>
            </div>
          )}

          {/* Show extracted value for completed slots */}
          {isSlot && isCompleted && resolvedValue && (
            <div className="mt-1">
              <Badge className="bg-purple-500 text-white">
                {item.slot_name}: {resolvedValue}
              </Badge>
            </div>
          )}

          {/* Show source transcript if available */}
          {status.source_transcript && (
            <p className="mt-1 text-xs text-muted-foreground italic truncate">
              "{status.source_transcript}"
            </p>
          )}
        </div>

        {/* Skip button */}
        {isPending && !isSlot && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSkip}
            disabled={isSubmitting}
            className="h-8 px-2 text-muted-foreground hover:text-amber-500"
            title="Skip this item"
          >
            <SkipForward className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

export default WorkflowChecklist;
