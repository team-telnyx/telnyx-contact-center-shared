"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { useSyncExternalStore } from "react";
import { interactionClock } from "@/lib/contact-center/interaction-clock.mjs";
import { Badge } from "@/components/ui/badge";

const noSubscribe = () => () => {};
const noSnapshot = () => null;
export default function InteractionSla({ sla, now: suppliedNow }) {
  const tUi = useUiText();
  const ticking = suppliedNow === undefined && Boolean(sla?.deadline_at) && !sla?.served_at && ["pending", "breached"].includes(sla?.state);
  const clockNow = useSyncExternalStore(ticking ? interactionClock.subscribe : noSubscribe, ticking ? interactionClock.getSnapshot : noSnapshot, noSnapshot);
  const now = suppliedNow === undefined ? clockNow : suppliedNow;
  if (!sla)
    return (
      <span className="text-[10px] text-muted-foreground">{tUi("SLA unavailable")}</span>
    );
  const measuredState =
    sla.state === "pending" &&
    now &&
    sla.deadline_at &&
    now >= Date.parse(sla.deadline_at)
      ? "breached"
      : sla.state;
  const atRisk =
    measuredState === "pending" &&
    (sla.at_risk ||
      (now &&
        sla.deadline_at &&
        now >=
          Date.parse(sla.deadline_at) -
            sla.policy?.thresholdSeconds *
              1000 *
              (1 - (sla.policy?.warningPercentage ?? 80) / 100)));
  const state = atRisk
    ? "At risk"
    : {
        met: "Within SLA",
        breached: "SLA breached",
        pending: "Pending",
        unserved: "Unserved",
        not_configured: "SLA not configured",
        disabled: "SLA disabled",
        excluded: "SLA excluded",
      }[measuredState] || "SLA unavailable";
  const seconds =
    sla.deadline_at && now
      ? Math.max(0, Math.round((Date.parse(sla.deadline_at) - now) / 1000))
      : null;
  const elapsed =
    seconds == null ||
    sla.served_at ||
    !["pending", "breached"].includes(measuredState)
      ? ""
      : seconds > 0
        ? tUi(" · {value0} left", { value0: seconds >= 60 ? Math.ceil(seconds / 60) + "m" : seconds + "s" })
        : tUi(" · overdue");
  return (
    <Badge
      variant="outline"
      className={`whitespace-nowrap text-[10px] ${measuredState === "breached" || measuredState === "unserved" ? "border-rose-500/30 text-rose-600 dark:text-rose-400" : atRisk ? "border-amber-500/30 text-amber-600 dark:text-amber-400" : measuredState === "met" ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
      title={
        sla.excluded_reason || (sla.policy
          ? tUi("{value0} · revision {value1} · {value2}s · target {value3}%", { value0: sla.policy.source || tUi("Policy"), value1: sla.policy.revision || 0, value2: sla.policy?.thresholdSeconds ?? "—", value3: sla.policy.targetPercentage ?? "—" })
          : undefined)
      }
    >
      {tUi(state)}
      {elapsed}
    </Badge>
  );
}
