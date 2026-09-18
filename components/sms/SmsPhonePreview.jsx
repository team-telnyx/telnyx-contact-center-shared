"use client";
import { IconAlertCircle, IconCheck, IconChevronLeft, IconClock, IconUser } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

// Phone mock-up for SMS previews: the same frame as the WhatsApp preview with a
// Messages-style conversation. Messages: { direction, text, status, timestamp }.
function DeliveryLabel({ status }) {
  const value = String(status || "").toLowerCase();
  if (["delivered", "read", "replied"].includes(value)) return <span className="flex items-center gap-0.5"><IconCheck className="size-3" aria-hidden="true" />Delivered</span>;
  if (["failed", "failed_permanent", "failed_transient", "undeliverable", "delivery_failed", "sending_failed"].includes(value)) return <span className="flex items-center gap-0.5 text-red-500"><IconAlertCircle className="size-3" aria-hidden="true" />Not delivered</span>;
  if (["queued", "sending", "pending", "rendered"].includes(value)) return <span className="flex items-center gap-0.5"><IconClock className="size-3" aria-hidden="true" />Sending</span>;
  return <span>Sent</span>;
}

export default function SmsPhonePreview({ messages = [], contactName = "Customer", senderLabel = "", className, emptyText = "The rendered message will appear here", ...rest }) {
  return (
    <div className={cn("mx-auto w-full max-w-[370px]", className)} data-testid="sms-phone-preview" {...rest}>
      <div className="rounded-[3.25rem] bg-[#101010] p-[10px] shadow-2xl ring-1 ring-black/20 dark:bg-gradient-to-br dark:from-zinc-400 dark:via-zinc-700 dark:to-zinc-500 dark:ring-white/20">
        <div className="relative flex h-[690px] flex-col overflow-hidden rounded-[2.65rem] bg-white text-slate-900 dark:bg-black dark:text-slate-100">
          <div className="absolute left-1/2 top-2 z-20 h-7 w-28 -translate-x-1/2 rounded-full bg-black" />
          <div className="flex h-12 shrink-0 items-end justify-between bg-[#f6f6f6] px-6 pb-1.5 text-[11px] dark:bg-[#1c1c1e]"><span>9:41</span><span>5G&nbsp; ◉</span></div>
          <div className="flex h-16 shrink-0 flex-col items-center justify-center border-b border-black/5 bg-[#f6f6f6] dark:border-white/10 dark:bg-[#1c1c1e]">
            <div className="absolute left-4 top-[60px] text-sky-500"><IconChevronLeft className="size-5" /></div>
            <div className="grid size-8 place-items-center rounded-full bg-slate-300 text-white dark:bg-slate-600"><IconUser className="size-4" /></div>
            <div className="mt-0.5 max-w-[200px] truncate text-[11px] font-medium">{contactName}</div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-4">
            {senderLabel ? <div className="mb-3 text-center text-[10px] text-slate-400">Text message · from {senderLabel}</div> : null}
            {!messages.length ? <div className="grid h-4/5 place-items-center text-center text-xs text-slate-400">{emptyText}</div> : (
              <div className="space-y-2">
                {messages.map((message, index) => {
                  const outbound = message.direction !== "inbound";
                  return (
                    <div key={message.id || index} className={cn("flex flex-col", outbound ? "items-end" : "items-start")}>
                      <div className={cn("max-w-[84%] rounded-2xl px-3 py-2 text-[13px] leading-[1.35] whitespace-pre-wrap [overflow-wrap:anywhere]", outbound ? "rounded-br-md bg-[#34c759] text-white" : "rounded-bl-md bg-[#e9e9eb] text-slate-900 dark:bg-[#26262a] dark:text-slate-100")}>{message.text || ""}</div>
                      {outbound ? <div className="mt-0.5 pr-1 text-[9px] text-slate-400"><DeliveryLabel status={message.status} /></div> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex h-16 shrink-0 items-center gap-2 bg-[#f6f6f6] px-3 dark:bg-[#1c1c1e]">
            <div className="flex h-9 flex-1 items-center rounded-full border border-black/10 bg-white px-4 text-xs text-slate-400 dark:border-white/10 dark:bg-[#2c2c2e]">Text Message</div>
          </div>
          <div className="h-5 shrink-0 bg-[#f6f6f6] dark:bg-[#1c1c1e]"><div className="mx-auto mt-2 h-1 w-28 rounded-full bg-black dark:bg-white" /></div>
        </div>
      </div>
    </div>
  );
}
