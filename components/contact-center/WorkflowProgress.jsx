"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CheckCircle, Clock, SkipForward } from "lucide-react";
import useWorkflowStore from "@/lib/stores/workflow-store";

/**
 * WorkflowProgress Component
 * 
 * Shows overall workflow completion progress bar.
 */
export function WorkflowProgress() {
  const tUi = useUiText();
  const {
    session,
    totalItems,
    completedItems,
    skippedItems,
    completionPercentage,
  } = useWorkflowStore();

  const pendingItems = totalItems - completedItems - skippedItems;
  const isComplete = session?.status === "completed";

  return (
    <div className="bg-card border-2 border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{tUi("Progress")}</span>
          {isComplete && (
            <Badge className="bg-green-500 text-white">
              <CheckCircle className="h-3 w-3 mr-1" />{tUi("Complete")}</Badge>
          )}
        </div>
        <span className="text-sm font-bold text-green-500">
          {completionPercentage}%
        </span>
      </div>
      
      <Progress 
        value={completionPercentage} 
        className="h-2 bg-muted"
        indicatorClassName="bg-green-500"
      />
      
      <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1">
            <CheckCircle className="h-3.5 w-3.5 text-green-500" />
            {completedItems}{tUi(" completed")}</span>
          {skippedItems > 0 && (
            <span className="flex items-center gap-1">
              <SkipForward className="h-3.5 w-3.5 text-amber-500" />
              {skippedItems}{tUi(" skipped")}</span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            {pendingItems}{tUi(" pending")}</span>
        </div>
        <span>
          {totalItems}{tUi(" total items")}</span>
      </div>
    </div>
  );
}

export default WorkflowProgress;
