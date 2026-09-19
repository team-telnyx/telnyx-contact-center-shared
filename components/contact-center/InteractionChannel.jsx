"use client";
import {
  Layers,
  Mail,
  MessageCircle,
  MessagesSquare,
  Phone,
  Video,
} from "lucide-react";
import { IconBrandWhatsapp } from "@tabler/icons-react";
import {
  channelDefinition,
  RELEASED_CHANNELS,
} from "@/lib/acd/channel-registry.mjs";
const icons = {
  phone: Phone,
  mail: Mail,
  message: MessageCircle,
  messages: MessagesSquare,
  whatsapp: IconBrandWhatsapp,
  video: Video,
  layers: Layers,
};
const tones = {
  sky: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  emerald: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  green: "bg-green-600/10 text-green-700 dark:text-green-300",
  violet: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  amber: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  rose: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  slate: "bg-muted text-muted-foreground",
};
export function InteractionChannel({ channel, label = false }) {
  const definition = channelDefinition(channel),
    Icon = icons[definition.icon] || Layers;
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap"
      title={definition.label}
    >
      <span
        className={`inline-grid size-8 shrink-0 place-items-center rounded-xl ${tones[definition.tone] || tones.slate}`}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className={label ? "text-sm font-medium" : "sr-only"}>
        {definition.label}
      </span>
    </span>
  );
}
export function ChannelFilter({
  value = "all",
  onChange,
  channels = RELEASED_CHANNELS,
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded-xl border bg-muted/30 p-1"
      aria-label="Communication channel"
    >
      {["all", ...channels].map((channel) => (
        <button
          key={channel}
          type="button"
          aria-pressed={value === channel}
          onClick={() => onChange(channel)}
          className={`rounded-lg px-3 py-2 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${value === channel ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-background/70 hover:text-foreground"}`}
        >
          {channel === "all"
            ? "All channels"
            : channelDefinition(channel).label}
        </button>
      ))}
    </div>
  );
}
