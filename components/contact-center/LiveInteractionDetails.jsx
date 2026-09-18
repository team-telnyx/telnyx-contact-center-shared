"use client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { InteractionChannel } from "./InteractionChannel";
import InteractionSla from "./InteractionSla";
import InteractionStateBadge from "./InteractionStateBadge";

export default function LiveInteractionDetails({ open, onOpenChange, interaction: row }) {
  const fields = [
    ["From", row.fromNumber], ["To", row.toNumber],
    ["Queue", row.queueName || "Outside queues"], ["Agent", row.agentName || row.agentUsername],
    ["Started", row.createdAt ? new Date(row.createdAt).toLocaleString() : null],
    ["Waiting reason", row.waitingReason],
    ["Interaction ID", row.workItemId || row.id], ["Leg ID", row.legId],
    ["Flow", row.flowName || row.flowId],
    ["Call control ID", row.callControlId],
  ].filter(([, value]) => value);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3"><InteractionChannel channel={row.channel} />Live interaction</DialogTitle>
        <DialogDescription>Read-only details of the selected interaction{row.legId ? " leg" : ""}.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/30 p-4">
        <Badge variant="outline">{row.kind?.replaceAll("_", " ") || row.direction}</Badge>
        <InteractionStateBadge state={row.state} />
        <InteractionSla sla={row.sla} />
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        {fields.map(([label, value]) => <div key={label} className="min-w-0 rounded-xl border p-4">
          <dt className="mb-1 text-xs text-muted-foreground">{label}</dt>
          <dd className="break-words text-sm font-medium [overflow-wrap:anywhere]">{value}</dd>
        </div>)}
      </dl>
    </DialogContent>
  </Dialog>;
}
