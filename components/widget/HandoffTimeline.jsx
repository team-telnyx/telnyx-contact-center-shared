import WidgetIcon from "./WidgetIcon";
import { handoffTimelinePhases } from "@/lib/widgets/handoff-timeline";

function interpolateHandoffMessage(template, handoff, ui) {
  return String(template || "")
    .replaceAll("{queue}", handoff?.queueName || ui.preview.fallbackQueue)
    .replaceAll("{agent}", handoff?.agentName || ui.preview.fallbackAgent);
}

function HandoffEvent({ event, config }) {
  const presentation = config.components.handoff;
  const pill = (
    <div
      className={`flex items-center gap-2 border px-3 py-2 font-medium shadow-sm ${presentation.style === "card" ? "w-full" : "max-w-[92%]"}`}
      style={{
        backgroundColor: event.appearance.backgroundColor,
        color: event.appearance.textColor,
        borderColor: event.appearance.borderColor,
        borderRadius: presentation.radius,
        fontSize: presentation.fontSize,
      }}
    >
      <WidgetIcon name={event.appearance.icon} fallback="info" size={presentation.iconSize} className="shrink-0" />
      <span className="min-w-0 text-center leading-snug">{event.message}</span>
    </div>
  );
  if (presentation.style !== "divider") {
    return <div className={`flex w-full ${presentation.style === "card" ? "justify-stretch" : "justify-center"}`}>{pill}</div>;
  }
  return (
    <div className="flex w-full items-center gap-2" role="separator">
      <span className="h-px min-w-3 flex-1" style={{ backgroundColor: event.appearance.borderColor }} />
      {pill}
      <span className="h-px min-w-3 flex-1" style={{ backgroundColor: event.appearance.borderColor }} />
    </div>
  );
}

export default function HandoffTimeline({
  config,
  handoff,
  ui,
  previewAll = false,
  phase = "transition",
}) {
  if (!handoff) return null;
  const presentation = config.components.handoff;
  const { assigned, connected, disconnected, failed } = handoffTimelinePhases(handoff);
  const candidates = [
    {
      key: "queue",
      visible: previewAll || !failed,
      appearance: presentation.queue,
      message: interpolateHandoffMessage(config.content.handoffWaitingMessage, handoff, ui),
    },
    {
      key: "assigned",
      visible: previewAll || assigned,
      appearance: presentation.assigned,
      message: interpolateHandoffMessage(config.content.handoffAssignedMessage, handoff, ui),
    },
    {
      key: "connected",
      visible: previewAll || connected,
      appearance: presentation.connected,
      message: interpolateHandoffMessage(config.content.handoffConnectedMessage, handoff, ui),
    },
    {
      key: "disconnected",
      visible: previewAll || disconnected,
      appearance: presentation.disconnected,
      message: interpolateHandoffMessage(config.content.handoffDisconnectedMessage, handoff, ui),
    },
    {
      key: "failed",
      visible: previewAll || failed,
      appearance: presentation.failed,
      message: interpolateHandoffMessage(config.content.handoffFailedMessage, handoff, ui),
    },
  ]
    .filter((event) => (phase === "closing") === (event.key === "disconnected"))
    .filter((event) => event.visible && event.appearance.enabled);
  if (!candidates.length) return null;
  return (
    <div className="mt-4 grid w-full" style={{ gap: presentation.spacing }} aria-label={ui.preview.handoffStatus} aria-live="polite">
      {candidates.map((event) => <HandoffEvent key={event.key} event={event} config={config} />)}
    </div>
  );
}
