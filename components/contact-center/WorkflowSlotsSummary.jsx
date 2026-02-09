"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Database, Edit2, Check, X, Copy, CheckCheck } from "lucide-react";
import useWorkflowStore from "@/lib/stores/workflow-store";
import { notify } from "@/components/ToastNotify";

/**
 * WorkflowSlotsSummary Component
 * 
 * Displays a summary of all filled slot values with ability to edit.
 */
export function WorkflowSlotsSummary() {
  const { stages, slotsFilled, updateSlotValue } = useWorkflowStore();

  // Extract all slot items from all stages
  const slotItems = stages.flatMap((stage) =>
    (stage.items || []).filter((item) => item.type === "slot")
  );

  // Get filled slots with their item info
  const filledSlots = slotItems
    .filter((item) => slotsFilled[item.slot_name])
    .map((item) => ({
      ...item,
      value: slotsFilled[item.slot_name],
    }));

  // Get unfilled required slots
  const unfilledSlots = slotItems.filter(
    (item) => !slotsFilled[item.slot_name] && item.is_required
  );

  return (
    <Card className="border-2 border-border bg-card h-full flex flex-col">
      <CardHeader className="pb-3 flex-shrink-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="h-5 w-5 text-green-500" />
          Captured Data
          {filledSlots.length > 0 && (
            <Badge variant="outline" className="ml-auto bg-green-500/10 text-green-500 border-green-500/50">
              {filledSlots.length}/{slotItems.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      
      <CardContent className="flex-1 min-h-0 p-0">
        <ScrollArea className="h-full px-4 pb-4">
          {slotItems.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              <Database className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No data fields in this workflow</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Filled Slots */}
              {filledSlots.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Captured
                  </p>
                  {filledSlots.map((slot) => (
                    <SlotItem
                      key={slot.id}
                      slot={slot}
                      onUpdate={updateSlotValue}
                    />
                  ))}
                </div>
              )}

              {/* Unfilled Required Slots */}
              {unfilledSlots.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Missing
                  </p>
                  {unfilledSlots.map((slot) => (
                    <div
                      key={slot.id}
                      className="p-2 rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5"
                    >
                      <p className="text-xs text-amber-500 font-medium">
                        {slot.label}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {slot.slot_name}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* All slots filled message */}
              {filledSlots.length === slotItems.length && slotItems.length > 0 && (
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/50 text-center">
                  <CheckCheck className="h-5 w-5 text-green-500 mx-auto mb-1" />
                  <p className="text-xs text-green-500 font-medium">
                    All data captured!
                  </p>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/**
 * Individual slot item with edit capability
 */
function SlotItem({ slot, onUpdate }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(slot.value);
  const [isCopied, setIsCopied] = useState(false);

  const handleSave = async () => {
    if (editValue.trim() !== slot.value) {
      await onUpdate(slot.slot_name, editValue.trim());
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditValue(slot.value);
    setIsEditing(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(slot.value);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
    notify({
      title: "Copied",
      description: `${slot.slot_name} copied to clipboard`,
      variant: "success",
    });
  };

  return (
    <div className="p-2 rounded-lg border border-border bg-card hover:border-green-500/30 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground mb-0.5">{slot.label}</p>
          
          {isEditing ? (
            <div className="flex items-center gap-1">
              <Input
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                className="h-7 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                  if (e.key === "Escape") handleCancel();
                }}
              />
              <Button size="sm" variant="ghost" onClick={handleSave} className="h-7 w-7 p-0">
                <Check className="h-3.5 w-3.5 text-green-500" />
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancel} className="h-7 w-7 p-0">
                <X className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </div>
          ) : (
            <p className="text-sm font-medium truncate">{slot.value}</p>
          )}
        </div>

        {!isEditing && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCopy}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              title="Copy value"
            >
              {isCopied ? (
                <CheckCheck className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setIsEditing(true)}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              title="Edit value"
            >
              <Edit2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      
      {/* Slot type badge */}
      <Badge variant="outline" className="mt-1.5 text-xs bg-muted">
        {slot.slot_type || "text"}
      </Badge>
    </div>
  );
}

export default WorkflowSlotsSummary;
