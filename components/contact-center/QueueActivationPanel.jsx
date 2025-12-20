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

export function QueueActivationPanel({ queues, onUpdate }) {
  const [open, setOpen] = useState(false);
  const [localQueues, setLocalQueues] = useState(queues);
  const [loading, setLoading] = useState({});

  // Update local queues when prop changes
  useEffect(() => {
    setLocalQueues(queues);
  }, [queues]);

  // Listen for queue changes via SSE
  useEffect(() => {
    let queueEventSource = null;
    const connectQueueStream = () => {
      try {
        if (queueEventSource) {
          queueEventSource.close();
        }

        queueEventSource = new EventSource("/api/user/status-stream");
        queueEventSource.addEventListener("queue_changed", (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log("[QueueActivation] Queue changed via SSE:", data);
            if (
              data.type === "queue_created" ||
              data.type === "queue_updated" ||
              data.type === "queue_activation_changed"
            ) {
              // Reload queues when changes occur
              if (onUpdate) {
                onUpdate();
              }
            }
          } catch (err) {
            console.error(
              "[QueueActivation] Failed to parse queue SSE message:",
              err
            );
          }
        });

        queueEventSource.addEventListener("connected", () => {
          console.log("[QueueActivation] Connected to queue stream");
        });

        queueEventSource.onerror = (error) => {
          console.warn("[QueueActivation] Queue stream error:", error);
          if (queueEventSource) {
            queueEventSource.close();
            queueEventSource = null;
          }
          setTimeout(connectQueueStream, 5000);
        };
      } catch (err) {
        console.error(
          "[QueueActivation] Failed to connect to queue stream:",
          err
        );
        setTimeout(connectQueueStream, 5000);
      }
    };

    connectQueueStream();

    return () => {
      if (queueEventSource) {
        queueEventSource.close();
        queueEventSource = null;
      }
    };
  }, [onUpdate]);

  const handleToggle = async (queueId, checked) => {
    console.log("[QueueActivation] Toggling queue:", queueId, "to", checked);
    setLoading((prev) => ({ ...prev, [queueId]: true }));

    try {
      const endpoint = checked
        ? "/api/contact-center/agent/queues/activate"
        : "/api/contact-center/agent/queues/deactivate";

      console.log(
        "[QueueActivation] Calling endpoint:",
        endpoint,
        "with queueIds:",
        [queueId]
      );

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queueIds: [queueId] }),
      });

      const data = await res.json();
      console.log("[QueueActivation] Response:", data);

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
        console.error("[QueueActivation] Failed to toggle queue:", data.error);
        alert(data.error || "Failed to toggle queue");
        // Revert optimistic update
        setLocalQueues(queues);
      }
    } catch (err) {
      console.error("[QueueActivation] Error toggling queue:", err);
      alert("Failed to toggle queue: " + (err.message || "Unknown error"));
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
                    console.log(
                      "[QueueActivation] Checkbox changed:",
                      queue.id,
                      checked
                    );
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
                      console.log(
                        "[QueueActivation] Label clicked:",
                        queue.id,
                        !queue.activated
                      );
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
