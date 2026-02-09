"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, CheckCircle, Circle } from "lucide-react";
import useWorkflowStore from "@/lib/stores/workflow-store";

/**
 * WorkflowStageNav Component
 * 
 * Shows current stage indicator with prev/next navigation.
 * Example: "Call Opening (1/3)" with navigation arrows.
 */
export function WorkflowStageNav() {
  const {
    workflowName,
    stages,
    currentStageIndex,
    itemStatuses,
    nextStage,
    prevStage,
    goToStage,
  } = useWorkflowStore();

  const currentStage = stages[currentStageIndex];
  const totalStages = stages.length;

  // Calculate stage completion status
  const getStageCompletion = (stage) => {
    if (!stage?.items) return { completed: 0, total: 0, isComplete: false };
    
    const total = stage.items.length;
    const completed = stage.items.filter((item) => {
      const status = itemStatuses[item.id];
      return status?.status === "completed";
    }).length;
    
    return {
      completed,
      total,
      isComplete: completed === total && total > 0,
    };
  };

  const currentCompletion = getStageCompletion(currentStage);

  return (
    <div className="flex items-center gap-3 bg-card border-2 border-border rounded-lg px-4 py-3">
      {/* Workflow Name */}
      <div className="flex-shrink-0">
        <Badge variant="outline" className="bg-purple-500/10 text-purple-500 border-purple-500/50">
          {workflowName || "Workflow"}
        </Badge>
      </div>

      {/* Stage Navigation */}
      <div className="flex items-center gap-2 flex-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={prevStage}
          disabled={currentStageIndex === 0}
          className="h-8 w-8 p-0"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        {/* Stage Indicator */}
        <div className="flex-1 flex items-center justify-center gap-2">
          <span className="font-semibold text-foreground">
            {currentStage?.name || "Loading..."}
          </span>
          <span className="text-muted-foreground">
            ({currentStageIndex + 1}/{totalStages})
          </span>
          
          {/* Stage completion indicator */}
          {currentCompletion.total > 0 && (
            <Badge
              variant="outline"
              className={
                currentCompletion.isComplete
                  ? "bg-green-500/10 text-green-500 border-green-500/50"
                  : "bg-muted text-muted-foreground"
              }
            >
              {currentCompletion.completed}/{currentCompletion.total}
            </Badge>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={nextStage}
          disabled={currentStageIndex >= totalStages - 1}
          className="h-8 w-8 p-0"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Stage dots/indicators */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {stages.map((stage, index) => {
          const completion = getStageCompletion(stage);
          const isCurrent = index === currentStageIndex;
          const isComplete = completion.isComplete;

          return (
            <button
              key={stage.id}
              onClick={() => goToStage(index)}
              className={`
                w-6 h-6 rounded-full flex items-center justify-center transition-all
                ${isCurrent ? "ring-2 ring-purple-500 ring-offset-2 ring-offset-background" : ""}
                ${isComplete ? "bg-green-500 text-white" : "bg-muted hover:bg-muted/80"}
              `}
              title={`${stage.name} (${completion.completed}/${completion.total})`}
            >
              {isComplete ? (
                <CheckCircle className="h-3.5 w-3.5" />
              ) : (
                <span className="text-xs font-medium">{index + 1}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default WorkflowStageNav;
