"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Radio,
  ShieldCheck,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTelnyx } from "@/components/telephony-provider";
import { qualityRating } from "@/lib/telephony/quality.mjs";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
const number = (n, digits = 0) => (n == null ? "—" : n.toFixed(digits));
const metrics = [
  ["jitterMS", "Jitter", "ms", "#38bdf8"],
  ["rttMS", "Round trip", "ms", "#a78bfa"],
  ["lossPercent", "Packet loss", "%", "#fb7185"],
];
function useQualityDisplay() {
  const { quality, region, status } = useTelnyx();
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);
  const samples = quality?.samples || [],
    latest = samples.at(-1);
  const stale = !!latest && now - latest.timestamp > 12000;
  const live = quality?.active && !stale;
  const tone =
    !live || latest?.mos == null
      ? "#94a3b8"
      : latest?.mos >= 4.1
        ? "#00d6aa"
        : latest?.mos >= 3.7
          ? "#fbbf24"
          : latest?.mos >= 3.1 ? "#fb923c" : "#fb7185";
  const label = !quality?.active
    ? latest
      ? "Last call"
      : "No local call"
    : stale
      ? "Measurements paused"
      : qualityRating(latest?.mos);
  return { samples, latest, live, tone, label, region, status };
}

export function VoiceQualityTrigger({ compact = false, onClick, ref }) {
  const tUi = useUiText();
  const { latest, tone, label } = useQualityDisplay();
  const summary = (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Activity size={17} />{tUi(" Connection quality")}</div>
        <div className="mt-1 text-xs text-muted-foreground">{tUi(label)}</div>
      </div>
      <div className="text-right">
        <strong className="text-2xl tabular-nums" style={{ color: tone }}>
          {number(latest?.mos, 1)}
        </strong>
        <div className="text-[10px] text-muted-foreground">{tUi("estimated MOS / 5")}</div>
      </div>
    </div>
  );
  return (
    <Button
      variant="outline"
      className={compact ? "h-auto w-full rounded-2xl p-4 text-left" : "gap-2"}
      onClick={onClick}
      ref={ref}
      aria-label={tUi("Open WebRTC connection quality")}
    >
      {compact ? (
        <div className="w-full">{summary}</div>
      ) : (
        <>
          <Activity size={18} />{tUi("Connection quality")}</>
      )}
    </Button>
  );
}

export function VoiceQualityDialog({ open, onOpenChange, onCloseAutoFocus }) {
  const tUi = useUiText();
  const { samples, latest, live, tone, label, region, status } =
    useQualityDisplay();
  const content = (
    <div className="space-y-5" data-testid="voice-quality-panel">
      <div className="relative overflow-hidden rounded-3xl border bg-card p-6">
        <div className="flex items-center justify-between gap-6">
          <div className="space-y-3">
            <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs">
              <Radio size={13} />
              {tUi(live ? tUi("Live • This browser") : label)}
            </span>
            <h3 className="text-2xl font-semibold">{tUi("Hear every detail")}</h3>
            <p className="max-w-xs text-sm text-muted-foreground">{tUi("Your browser’s audio path to Telnyx, measured in real time.")}</p>
          </div>
          <div
            className="flex h-28 w-28 shrink-0 flex-col items-center justify-center rounded-full border-[5px] bg-background/60"
            style={{ borderColor: tone }}
          >
            <strong className="text-4xl tabular-nums">
              {number(latest?.mos, 1)}
            </strong>
            <span className="text-xs text-muted-foreground">{tUi("estimated MOS")}</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {metrics.map(([key, title, unit, color]) => (
          <div key={key} className="rounded-2xl border bg-muted/30 p-4">
            <div className="text-xs text-muted-foreground">{tUi(title)}</div>
            <div
              className="mt-2 text-xl font-semibold tabular-nums"
              style={{ color }}
            >
              {number(latest?.[key], key === "lossPercent" ? 1 : 0)}{" "}
              <span className="text-xs font-normal">{unit}</span>
            </div>
          </div>
        ))}
      </div>
      {!samples.length ? (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {live
            ? tUi("Waiting for RTP measurements…")
            : tUi("Start or answer a call in this browser to see live measurements. Calls on iPhone are measured on iPhone.")}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {[["mos", "Estimated MOS", "/ 5", "#00d6aa"], ...metrics].map(
            ([key, title, unit, color]) => (
              <div key={key} className="min-w-0 rounded-2xl border p-4">
                <h4 className="mb-3 text-sm font-medium">
                  {tUi(title)}{" "}
                  <span className="text-xs text-muted-foreground">{unit}</span>
                </h4>
                <div
                  className="h-36"
                  role="img"
                  aria-label={tUi("{value0} history for the last five minutes", { value0: title })}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={samples}>
                      <CartesianGrid
                        vertical={false}
                        stroke="currentColor"
                        strokeOpacity={0.08}
                      />
                      <XAxis
                        dataKey="timestamp"
                        type="number"
                        domain={["dataMin", "dataMax"]}
                        tickFormatter={(v) =>
                          new Date(v).toLocaleTimeString(tUi.locale, {
                            minute: "2-digit",
                            second: "2-digit",
                          })
                        }
                        minTickGap={40}
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis
                        domain={key === "mos" ? [1, 5] : [0, "auto"]}
                        width={30}
                        tick={{ fontSize: 10 }}
                      />
                      <Tooltip
                        labelFormatter={(v) => new Date(v).toLocaleTimeString(tUi.locale)}
                        formatter={(v) => [`${number(v, 1)} ${unit}`, title]}
                        contentStyle={{
                          background: "var(--background)",
                          borderRadius: 12,
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey={key}
                        stroke={color}
                        fill={color}
                        fillOpacity={0.12}
                        strokeWidth={2}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ),
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {[
          ["receiveKbps", "Incoming", ArrowDownLeft],
          ["sendKbps", "Outgoing", ArrowUpRight],
        ].map(([key, title, Icon]) => (
          <div
            key={key}
            className="flex items-center gap-3 rounded-2xl border p-4"
          >
            <Icon className="text-emerald-500" />
            <div>
              <p className="text-xs text-muted-foreground">{tUi(title)}{tUi(" audio")}</p>
              <strong className="tabular-nums">
                {number(latest?.[key], 1)}{tUi(" kbps")}</strong>
            </div>
          </div>
        ))}
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck size={16} /> {status}{tUi(" · Region ")}{region?.toUpperCase()}{tUi(" · 5-minute local history")}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{tUi("MOS is an estimate, not a listening test. Packet loss and bitrates use interval counters; missing values are shown as —. These measurements describe this browser’s leg, not the other participant’s network. No audio or raw network identifiers are recorded by this panel.")}</p>
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{tUi("WebRTC connection quality")}</DialogTitle>
          <DialogDescription>{tUi("Live audio diagnostics for this browser")}</DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}

export function VoiceQualityPanel({ compact = false }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  return (
    <>
      <VoiceQualityTrigger
        compact={compact}
        ref={triggerRef}
        onClick={() => setOpen(true)}
      />
      <VoiceQualityDialog
        open={open}
        onOpenChange={setOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      />
    </>
  );
}
