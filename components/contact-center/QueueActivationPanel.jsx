"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { notify } from "@/components/ToastNotify";
import { subscribeStatusStream } from "@/lib/status-stream-client";

export function QueueActivationPanel({ queues, onUpdate }) {
  const [open, setOpen] = useState(false);
  const [localQueues, setLocalQueues] = useState(queues);
  const [loading, setLoading] = useState({});

  // Update local queues when prop changes
  useEffect(() => {
    setLocalQueues(queues);
  }, [queues]);

  // Listen for queue changes via the shared SSE client.
  useEffect(() => {
    return subscribeStatusStream("queue_changed", (data) => {
      if (
        data?.type === "queue_created" ||
        data?.type === "queue_updated" ||
        data?.type === "queue_activation_changed"
      ) {
        if (onUpdate) {
          onUpdate();
        }
      }
    });
  }, [onUpdate]);

  const handleToggle = async (queueId, checked) => {
    setLoading((prev) => ({ ...prev, [queueId]: true }));

    try {
      const endpoint = checked
        ? "/api/contact-center/agent/queues/activate"
        : "/api/contact-center/agent/queues/deactivate";

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queueIds: [queueId] }),
      });

      const data = await res.json();

      if (data.ok) {
        // Optimistically update local state
        setLocalQueues((prev) =>
          prev.map((q) => (q.id === queueId ? { ...q, activated: checked } : q))
        );
        // Then reload from server to ensure consistency
        if (onUpdate) {
          await onUpdate();
        }
      } else {
        notify({ title: "Queue update failed", description: data.error || "Failed to toggle queue", variant: "error" });
        // Revert optimistic update
        setLocalQueues(queues);
      }
    } catch (err) {
      notify({ title: "Queue update failed", description: err.message || "Unknown error", variant: "error" });
      // Revert optimistic update
      setLocalQueues(queues);
    } finally {
      setLoading((prev) => {
        const next = { ...prev };
        delete next[queueId];
        return next;
      });
    }
  };

  const activatedCount = localQueues.filter((q) => q.activated).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline">
          Queues ({activatedCount}/{queues.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-3">
          <div className="font-semibold">Queue Activation</div>
          {localQueues.map((queue, index) => (
            <div
              key={queue.id}
              className="flex items-center justify-between gap-2"
            >
              <div className="flex items-center gap-2 flex-1">
                <Checkbox
                  checked={queue.activated || false}
                  onCheckedChange={(checked) => {
                    handleToggle(queue.id, checked === true);
                  }}
                  disabled={loading[queue.id]}
                  onClick={(e) => {
                    // Prevent double-triggering
                    e.stopPropagation();
                  }}
                />
                <label
                  className="text-sm font-medium cursor-pointer flex-1"
                  onClick={(e) => {
                    e.preventDefault();
                    if (!loading[queue.id]) {
                      handleToggle(queue.id, !queue.activated);
                    }
                  }}
                >
                  {queue.displayName || queue.name}
                </label>
              </div>
              <div className="flex items-center gap-1.5">
                {loading[queue.id] && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
                <Badge
                  className={`text-xs uppercase ${
                    queue.routingStrategy === "FIFO"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                      : queue.routingStrategy === "Skill-based"
                      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                      : queue.routingStrategy === "Priority-based"
                      ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
                      : "bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
                  }`}
                  variant="outline"
                >
                  {queue.routingStrategy || "FIFO"}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
