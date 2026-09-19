"use client";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { InteractionChannel } from "./InteractionChannel";
import { channelDefinition } from "@/lib/acd/channel-registry.mjs";

export default function InteractionRecordPreview({
  interaction,
  onOpenChange,
}) {
  const id = interaction?.work_item_id || interaction?.id;
  const [record, setRecord] = useState(null),
    [error, setError] = useState(null);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setRecord(null);
        setError(null);
      }
    });
    fetch(`/api/contact-center/interactions/${encodeURIComponent(id)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok)
          throw new Error(payload.error || "Record unavailable");
        return payload.interaction;
      })
      .then((value) => {
        if (!controller.signal.aborted) setRecord(value);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [id]);
  const channel =
    record?.channel || record?.interaction_type || interaction?.channel;
  return (
    <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="flex items-center gap-3">
          <InteractionChannel channel={channel} />
          Interaction record
        </DialogTitle>
        <DialogDescription>
          Historical evidence from your interaction. Read only.
        </DialogDescription>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : !record ? (
          <div className="space-y-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-48" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{record.state}</Badge>
              <Badge variant="outline">{record.direction}</Badge>
            </div>
            <dl className="grid grid-cols-2 gap-4 text-xs">
              {[
                ["From", record.from_number],
                ["To", record.to_number],
                ["Queue", record.queue_name],
                [
                  "Started",
                  record.created_at &&
                    new Date(record.created_at).toLocaleString(),
                ],
                [
                  "Closed",
                  record.terminal_at &&
                    new Date(record.terminal_at).toLocaleString(),
                ],
                ["Disposition", record.wrapup_code_names?.join(", ")],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-words">{value || "—"}</dd>
                </div>
              ))}
            </dl>
            {channelDefinition(channel).capabilities.recordings &&
              record.recording_url && (
                <div>
                  <p className="mb-2 text-xs font-semibold">Recording</p>
                  {channel === "video" || record.metadata?.recording?.format === "mp4" ? (
                    <video
                      controls
                      preload="metadata"
                      playsInline
                      src={record.recording_url}
                      className="aspect-video w-full rounded-lg bg-black"
                    />
                  ) : (
                    <audio
                      controls
                      preload="none"
                      src={record.recording_url}
                      className="w-full"
                    />
                  )}
                </div>
              )}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Interaction journey</h3>
              {(record.acd_segments || []).map((segment) => (
                <div key={segment.id} className="border-l-2 pl-3 text-xs">
                  <p className="font-medium">
                    {segment.agent_name ||
                      segment.agent_username ||
                      segment.agent_id ||
                      segment.queue_name ||
                      segment.kind}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {segment.outcome || segment.kind} ·{" "}
                    {new Date(segment.started_at).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
