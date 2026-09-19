"use client";
import { IconAlertCircle, IconCheck, IconChecks, IconChevronLeft, IconClock, IconFile, IconMapPin, IconMicrophone, IconPhone, IconPhoto, IconSearch, IconUser, IconVideo } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { templatePreviewParts } from "@/lib/whatsapp/templates.mjs";

// The iPhone mock-up from the demo portal: status bar, WhatsApp chat header,
// encrypted-chat notice, bubbles with delivery ticks and the composer strip.
// Messages: { direction, status, kind, text, timestamp, template, values, mediaType, mediaUrl, filename, locationName, locationAddress }.
function DeliveryIcon({ status }) {
  const value = String(status || "").toLowerCase();
  const props = { className: cn("size-3.5 shrink-0", value === "read" ? "text-sky-500" : ["failed", "delivery_failed", "sending_failed", "undeliverable"].includes(value) ? "text-red-500" : "text-slate-500") };
  if (["read", "delivered"].includes(value)) return <IconChecks {...props} aria-label={value === "read" ? "Read" : "Delivered"} />;
  if (["sent", "accepted"].includes(value)) return <IconCheck {...props} aria-label="Sent" />;
  if (["failed", "delivery_failed", "sending_failed", "undeliverable"].includes(value)) return <IconAlertCircle {...props} aria-label="Failed" />;
  if (["queued", "sending", "pending"].includes(value)) return <IconClock {...props} aria-label="Sending" />;
  return null;
}
const fill = (text, values, scope) => String(text || "").replace(/\{\{(\d+)\}\}/g, (match, index) => values?.[`${scope}:${index}`] || match);

function TemplateBubble({ message }) {
  const parts = templatePreviewParts(message.template || {});
  const header = String(parts.headerFormat || "NONE").toUpperCase();
  const HeaderIcon = header === "VIDEO" ? IconVideo : header === "DOCUMENT" ? IconFile : IconPhoto;
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#008069] dark:text-[#00a884]">{message.template?.name || "Template"}</div>
      {["IMAGE", "VIDEO", "DOCUMENT"].includes(header) && <div className="grid h-24 place-items-center rounded-md bg-slate-200 text-slate-500 dark:bg-white/10 dark:text-slate-300"><HeaderIcon className="size-7" /></div>}
      {parts.header && header === "TEXT" && <div className="font-semibold">{fill(parts.header, message.values, "header")}</div>}
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{fill(parts.body, message.values, "body") || "Template message preview"}</p>
      {parts.footer && <div className="text-[10px] text-slate-500 dark:text-slate-300">{parts.footer}</div>}
      {(parts.buttons || []).map((button, index) => <div key={index} className="mt-2 border-t border-black/10 pt-1.5 text-center text-xs font-medium text-sky-600 dark:border-white/10 dark:text-sky-400">{button.text || `Button ${index + 1}`}</div>)}
    </div>
  );
}
// Preview pictures come from the conversation itself; next/image cannot optimize them.
function PreviewImage({ url }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="max-h-56 w-full rounded-md object-cover" />;
}
function BubbleContent({ message }) {
  if (message.kind === "template") return <TemplateBubble message={message} />;
  if (["image", "sticker"].includes(message.kind)) return <div className="space-y-1.5">{message.mediaUrl ? <PreviewImage url={message.mediaUrl} /> : <div className="grid h-32 place-items-center rounded-md bg-slate-200 text-xs text-slate-500 dark:bg-white/10 dark:text-slate-300">Image</div>}{message.text && <p className="whitespace-pre-wrap">{message.text}</p>}</div>;
  if (message.kind === "video") return <div className="space-y-1.5"><div className="grid h-36 place-items-center rounded-md bg-slate-800 text-white"><IconVideo className="size-9" /></div>{message.text && <p className="whitespace-pre-wrap">{message.text}</p>}</div>;
  if (message.kind === "audio") return <div className="flex min-w-[220px] items-center gap-2 rounded-md bg-black/5 p-2 dark:bg-black/20"><div className="grid size-9 place-items-center rounded-full bg-[#00a884] text-white"><IconMicrophone className="size-5" /></div><div className="h-1 flex-1 rounded bg-slate-300" /></div>;
  if (message.kind === "document") return <div className="flex min-w-[220px] items-center gap-3 rounded-md bg-white/70 p-2.5 dark:bg-black/20"><div className="grid size-11 shrink-0 place-items-center rounded-md bg-rose-100"><IconFile className="size-7 text-rose-500" /></div><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{message.filename || "Document"}</span><span className="block text-[10px] uppercase text-slate-500 dark:text-slate-300">{message.filename?.split(".").pop() || "file"}</span></span></div>;
  if (message.kind === "location") return <div className="overflow-hidden rounded-md bg-white dark:bg-[#111b21]"><div className="grid h-24 place-items-center bg-[radial-gradient(circle_at_center,_#b9d7bb,_#dce8d8_55%,_#bdd2b9)]"><IconMapPin className="size-9 text-red-500" /></div>{(message.locationName || message.locationAddress) && <div className="p-2">{message.locationName && <div className="font-semibold">{message.locationName}</div>}{message.locationAddress && <div className="text-[11px] text-slate-500 dark:text-slate-300">{message.locationAddress}</div>}</div>}</div>;
  return <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text || ""}</p>;
}

export default function WhatsAppPhonePreview({ messages = [], contactName = "WhatsApp contact", className, emptyText = "Messages will appear here", ...rest }) {
  return (
    <div className={cn("mx-auto w-full max-w-[370px]", className)} data-testid="whatsapp-phone-preview" {...rest}>
      <div className="rounded-[3.25rem] bg-[#101010] p-[10px] shadow-2xl ring-1 ring-black/20 dark:bg-gradient-to-br dark:from-zinc-400 dark:via-zinc-700 dark:to-zinc-500 dark:ring-white/20">
        <div className="relative flex h-[690px] flex-col overflow-hidden rounded-[2.65rem] bg-[#efeae2] text-slate-900 dark:bg-[#0b141a] dark:text-[#e9edef]">
          <div className="absolute left-1/2 top-2 z-20 h-7 w-28 -translate-x-1/2 rounded-full bg-black" />
          <div className="flex h-12 shrink-0 items-end justify-between bg-[#075e54] px-6 pb-1.5 text-[11px] text-white dark:bg-[#202c33]"><span>9:41</span><span>5G&nbsp; ◉</span></div>
          <div className="flex h-14 shrink-0 items-center gap-2 bg-[#075e54] px-3 text-white dark:bg-[#202c33]">
            <IconChevronLeft className="size-5" />
            <div className="grid size-9 place-items-center rounded-full bg-white/20"><IconUser className="size-5" /></div>
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{contactName}</div><div className="text-[10px] text-white/75">online</div></div>
            <IconVideo className="size-5" /><IconPhone className="size-5" /><IconSearch className="size-5" />
          </div>
          <div className="flex-1 overflow-y-auto bg-[linear-gradient(rgba(239,234,226,.91),rgba(239,234,226,.91)),radial-gradient(circle_at_20%_20%,#cad4bd_1px,transparent_1px)] bg-[length:auto,18px_18px] px-3 py-4 dark:bg-[linear-gradient(rgba(11,20,26,.96),rgba(11,20,26,.96)),radial-gradient(circle_at_20%_20%,#25343c_1px,transparent_1px)]">
            <div className="mb-4 text-center"><span className="rounded-md bg-[#fff4c7] px-2 py-1 text-[9px] text-slate-600 shadow-sm dark:bg-[#182229] dark:text-[#ffd279]">Messages are end-to-end encrypted</span></div>
            {!messages.length ? <div className="grid h-4/5 place-items-center text-center text-xs text-slate-500 dark:text-slate-400">{emptyText}</div> : (
              <div className="space-y-2">
                {messages.map((message, index) => {
                  const outbound = message.direction !== "inbound";
                  const time = message.timestamp ? new Date(message.timestamp) : null;
                  return (
                    <div key={message.id || index} className={cn("flex", outbound ? "justify-end" : "justify-start")}>
                      <div className={cn("relative max-w-[86%] rounded-lg px-2.5 py-2 text-[13px] leading-[1.35] shadow-sm", outbound ? "bg-[#d9fdd3] dark:bg-[#005c4b] dark:text-[#e9edef]" : "bg-white dark:bg-[#202c33] dark:text-[#e9edef]")}>
                        <BubbleContent message={message} />
                        <div className="mt-1 flex min-h-4 items-end justify-end gap-2 text-[9px] text-slate-500 dark:text-slate-300">
                          <span className="flex items-center gap-0.5"><span suppressHydrationWarning>{time && !Number.isNaN(time.getTime()) ? time.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }) : "09:31"}</span>{outbound && <DeliveryIcon status={message.status} />}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex h-16 shrink-0 items-center gap-2 bg-[#f0f2f5] px-3 dark:bg-[#202c33]">
            <div className="flex h-10 flex-1 items-center rounded-full bg-white px-4 text-xs text-slate-400 dark:bg-[#2a3942] dark:text-slate-400">Message</div>
            <div className="grid size-10 place-items-center rounded-full bg-[#00a884] text-white"><IconMicrophone className="size-5" /></div>
          </div>
          <div className="h-5 shrink-0 bg-[#f0f2f5] dark:bg-[#202c33]"><div className="mx-auto mt-2 h-1 w-28 rounded-full bg-black dark:bg-white" /></div>
        </div>
      </div>
    </div>
  );
}
