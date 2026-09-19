"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  assistantThinkingMessages,
  widgetDirection,
  widgetTranslations,
} from "@/lib/widgets/locales";
import HandoffTimeline from "./HandoffTimeline";
import VoiceWidgetRuntime from "./VoiceWidgetRuntime";
import VideoWidgetRuntime from "./VideoWidgetRuntime";
import { requestFreshWidgetBootstrap } from "@/lib/widgets/bootstrap-client";
import WidgetIcon from "./WidgetIcon";
import DocumentPreview from "@/components/documents/DocumentPreview";
import { documentPreviewKind } from "@/lib/documents/preview-types.mjs";
import { attachmentAccept, isAttachmentTypeAllowed } from "@/lib/widgets/attachment-types.mjs";
import { safeImageUrl } from "@/lib/security/display-url.mjs";

const QUICK_EMOJI = ["😀", "😊", "👍", "❤️", "🎉", "🙏", "👋", "🤔"];

function indicatorAlignmentClasses(alignment) {
  if (alignment === "center") return { container: "justify-center", badge: "max-w-[88%]" };
  if (alignment === "right") return { container: "justify-end", badge: "max-w-[88%]" };
  if (alignment === "full") return { container: "justify-stretch", badge: "w-full justify-center text-center" };
  return { container: "justify-start", badge: "max-w-[88%]" };
}

function mergeMessages(current, incoming) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return Array.from(byId.values()).sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );
}

// The embedding page passes its origin as ?parentOrigin=, and every message the
// widget posts back should be addressed to it. "*" stays as the fallback for
// hosts that predate the parameter, but it is a fallback rather than the
// default: with "*" any page that can see this frame receives the message.
function parentTargetOrigin() {
  if (typeof window === "undefined") return "*";
  return new URLSearchParams(window.location.search).get("parentOrigin") || "*";
}

function Avatar({ spec, fallbackSpec = null, color, textColor, size = 36 }) {
  const [failedImageUrl, setFailedImageUrl] = useState(null);
  const imageFailed = spec?.type === "image" && failedImageUrl === spec.value;
  const style = { backgroundColor: color, color: textColor, width: size, height: size };
  const safeSrc = spec?.type === "image" ? safeImageUrl(spec.value) : null;
  if (safeSrc && !imageFailed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} src={safeSrc} alt="" onError={() => setFailedImageUrl(spec.value)} />;
  }
  const visibleSpec = imageFailed && fallbackSpec ? fallbackSpec : spec;
  return (
    <span className="grid shrink-0 place-items-center rounded-full text-xs font-bold" style={style}>
      {visibleSpec?.type === "initials" ? visibleSpec.value.slice(0, 3) : <WidgetIcon name={visibleSpec?.value} fallback="user" size={Math.max(14, Math.round(size * 0.48))} />}
    </span>
  );
}

function AssistantThinkingBadge({ active, config }) {
  const [messageIndex, setMessageIndex] = useState(0);
  const indicator = config.components.messages.typingIndicator;
  const rotatingMessages = assistantThinkingMessages(config.locale);
  const rotate = indicator.rotatingMessages && rotatingMessages.length > 1;

  useEffect(() => {
    if (!active || !rotate) return undefined;
    const timer = window.setInterval(() => {
      setMessageIndex((current) => (current + 1) % rotatingMessages.length);
    }, 1_800);
    return () => window.clearInterval(timer);
  }, [active, rotate, rotatingMessages.length]);

  if (!active) return null;
  const message = indicator.rotatingMessages
    ? rotatingMessages[messageIndex % rotatingMessages.length]
    : config.content.assistantTypingMessage;
  const alignment = indicatorAlignmentClasses(indicator.alignment);

  return (
    <div className={`flex ${alignment.container}`} role="status" aria-live="polite" aria-label={message}>
      <div
        className={`inline-flex items-center gap-2 border px-3.5 py-2 font-medium shadow-sm ${alignment.badge}`}
        style={{
          backgroundColor: indicator.backgroundColor,
          borderColor: indicator.borderColor,
          borderRadius: 999,
          color: indicator.textColor,
          fontSize: indicator.fontSize,
        }}
      >
        <WidgetIcon
          name={indicator.spinnerIcon}
          fallback="loader-circle"
          size={Math.max(14, indicator.fontSize + 3)}
          className="shrink-0 motion-safe:animate-spin"
          aria-hidden="true"
        />
        <span>{message}</span>
      </div>
    </div>
  );
}

function AgentTypingBadge({ config, agentName, typingUntil = null, previewActive = false }) {
  const indicator = config.components.messages.agentTypingIndicator;
  const [clock, setClock] = useState(() => Date.now());
  const expiresAt = new Date(typingUntil || 0).getTime();

  useEffect(() => {
    const remaining = expiresAt - Date.now();
    if (previewActive || remaining <= 0) return undefined;
    const timer = window.setTimeout(() => setClock(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt, previewActive]);

  const visible = previewActive || expiresAt > clock;
  if (!indicator.enabled || !visible) return null;
  const message = config.content.agentTypingMessage.replace(
    /\{agent\}/g,
    agentName || config.components.messages.humanLabel
  );
  const alignment = indicatorAlignmentClasses(indicator.alignment);
  return (
    <div className={`flex ${alignment.container}`} role="status" aria-live="polite" aria-label={message}>
      <div
        className={`inline-flex items-center gap-2 border px-3.5 py-2 font-medium shadow-sm ${alignment.badge}`}
        style={{
          backgroundColor: indicator.backgroundColor,
          borderColor: indicator.borderColor,
          borderRadius: 999,
          color: indicator.textColor,
          fontSize: indicator.fontSize,
        }}
      >
        <WidgetIcon
          name={indicator.spinnerIcon}
          fallback="loader-circle"
          size={Math.max(14, indicator.fontSize + 3)}
          className="shrink-0 motion-safe:animate-spin"
          aria-hidden="true"
        />
        <span>{message}</span>
      </div>
    </div>
  );
}

function HumanAvatar({ config, message, sessionToken, previewAgent }) {
  const [runtimeImage, setRuntimeImage] = useState({ key: null, url: null });
  const useProfilePicture = Boolean(config.avatars.human.useAgentProfilePicture);
  const previewImageUrl = useProfilePicture ? previewAgent?.profileImageUrl : null;
  const runtimeImageKey = useProfilePicture && message?.agentAvatarId && sessionToken && !previewAgent
    ? `${message.agentAvatarId}:${sessionToken}`
    : null;

  useEffect(() => {
    if (!runtimeImageKey) return undefined;
    let cancelled = false;
    let objectUrl = null;
    void fetch(`/api/widget-sessions/agent-avatar/${encodeURIComponent(message.agentAvatarId)}`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      cache: "no-store",
    }).then(async (response) => {
      if (!response.ok) return;
      objectUrl = URL.createObjectURL(await response.blob());
      if (!cancelled) setRuntimeImage({ key: runtimeImageKey, url: objectUrl });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message?.agentAvatarId, runtimeImageKey, sessionToken]);

  const runtimeImageUrl = runtimeImage.key === runtimeImageKey ? runtimeImage.url : null;
  const imageUrl = previewImageUrl || (useProfilePicture ? message?.agentAvatarUrl : null) || runtimeImageUrl;
  return (
    <Avatar
      spec={imageUrl ? { type: "image", value: imageUrl } : config.avatars.human}
      fallbackSpec={config.avatars.human}
      color={config.theme.colors.humanBubble}
      textColor={config.theme.colors.humanText}
      size={config.components.messages.avatarSize}
    />
  );
}

function attachmentMimeType(attachment) {
  // Runtime attachments carry the real MIME in `mime`; Contact Center sends its coarse
  // Image/Video/Audio/File classification in `mediaType`, and the preview seeds
  // use `contentType`.
  return String(attachment.mime || attachment.contentType || attachment.mediaType || "").toLowerCase();
}

function formattedFileSize(size) {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return size || "";
  if (size < 1024) return `${size} B`;
  if (size < 1_048_576) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

function attachmentKind(attachment) {
  const mimeType = attachmentMimeType(attachment);
  const mediaType = String(attachment?.mediaType || "");
  if (mimeType.startsWith("image/") || mediaType === "Image") return "image";
  if (mimeType.startsWith("audio/") || mediaType === "Audio") return "audio";
  if (mimeType.startsWith("video/") || mediaType === "Video") return "video";
  if (mimeType === "application/pdf") return "pdf";
  return "file";
}

export function AttachmentPreviewModal({ attachment, config, ui, onClose, expanded = false }) {
  const displayUrl = attachment?.url || "";
  // Tracking which URL finished loading resets the spinner when the viewer moves
  // to another attachment, without an effect that would cascade a render.
  const [renderedUrl, setRenderedUrl] = useState(null);
  const rendered = Boolean(displayUrl) && renderedUrl === displayUrl;
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  if (!attachment) return null;
  const mimeType = attachmentMimeType(attachment);
  const kind = attachmentKind(attachment);
  const image = kind === "image";
  const playable = kind === "audio" || kind === "video";
  const name = attachment.filename || attachment.text || ui.preview.attachment;
  const isDocument = Boolean(documentPreviewKind(mimeType, name));
  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col ${expanded ? "" : "bg-black/70 p-3 backdrop-blur-sm"}`}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={expanded ? undefined : onClose}
    >
      <div
        className={`mx-auto flex max-h-full w-full flex-col overflow-hidden shadow-2xl ${expanded ? "my-auto h-full" : `max-w-2xl ${isDocument ? "h-[80dvh]" : ""}`}`}
        style={{ backgroundColor: config.theme.colors.surface, color: config.theme.colors.text, borderRadius: config.theme.shape.panelRadius }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3" style={{ borderColor: config.theme.colors.border }}>
          <WidgetIcon name={image ? config.components.attachments.imageIcon : config.components.attachments.documentIcon} fallback={image ? "image" : "file-text"} size={18} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-[11px] opacity-60">{mimeType || ui.preview.file}{attachment.size ? ` · ${formattedFileSize(attachment.size)}` : ""}</p>
          </div>
          {displayUrl && (
            <>
              {/* Not every browser frames a PDF inline, so there is always a way
                  to hand the file to the browser's own viewer. */}
              <a
                href={displayUrl}
                target="_blank"
                rel="noreferrer"
                className="grid shrink-0 place-items-center rounded-full p-2 hover:bg-black/5"
                aria-label={ui.aria.openAttachment}
              >
                <WidgetIcon name="external-link" fallback="external-link" size={18} />
              </a>
              <a
                href={displayUrl}
                download={name}
                className="grid shrink-0 place-items-center rounded-full p-2 hover:bg-black/5"
                aria-label={ui.aria.downloadAttachment}
              >
                <WidgetIcon name="download" fallback="download" size={18} />
              </a>
            </>
          )}
          <button type="button" onClick={onClose} className="grid shrink-0 place-items-center rounded-full p-2 hover:bg-black/5" aria-label={ui.aria.close}>
            <WidgetIcon name={config.components.header.closeIcon} fallback="x" size={18} />
          </button>
        </div>
        <div className="relative grid min-h-0 flex-1 place-items-center overflow-auto" style={{ backgroundColor: config.theme.colors.surfaceMuted }}>
          {(!displayUrl || (image && !rendered)) && (image || !displayUrl) && (
            <span
              className="absolute inset-0 z-10 grid place-items-center"
              style={{ backgroundColor: config.theme.colors.surfaceMuted }}
              role="status"
              aria-label={ui.aria.loading}
            >
              <span
                className="block rounded-full border-2 border-current border-t-transparent opacity-40 motion-safe:animate-spin"
                style={{ width: 28, height: 28 }}
              />
            </span>
          )}
          {displayUrl && image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displayUrl}
              alt={name}
              onLoad={() => setRenderedUrl(displayUrl)}
              onError={() => setRenderedUrl(displayUrl)}
              className={`block max-w-full object-contain ${expanded ? "max-h-full" : "max-h-[70vh]"}`}
            />
          )}
          {displayUrl && isDocument && (
            <DocumentPreview url={displayUrl} name={name} mimeType={mimeType} locale={config.locale} />
          )}
          {displayUrl && kind === "audio" && (
            <audio src={displayUrl} controls preload="metadata" className="w-full max-w-lg px-6" />
          )}
          {displayUrl && kind === "video" && (
            <video src={displayUrl} controls preload="metadata" className={`block max-w-full ${expanded ? "max-h-full" : "max-h-[70vh]"}`} />
          )}
          {(!displayUrl || (!image && !isDocument && !playable)) && (
            <div className="grid place-items-center gap-3 p-10 text-center">
              <WidgetIcon name={config.components.attachments.documentIcon} fallback="file-text" size={40} className="opacity-50" />
              <p className="text-sm opacity-70">{ui.preview.noInlinePreview}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AttachmentCard({ attachment, config, ui, onOpen }) {
  const component = config.components.attachments;
  const kind = attachmentKind(attachment);
  const displayUrl = attachment.url || "";
  const name = attachment.filename || attachment.text || ui.preview.attachment;
  const meta = `${attachmentMimeType(attachment) || ui.preview.file}${attachment.size ? ` · ${formattedFileSize(attachment.size)}` : ""}`;
  const surface = {
    borderColor: component.borderColor,
    backgroundColor: component.backgroundColor,
    color: component.textColor,
    borderRadius: component.radius,
  };
  const caption = (
    <span className="block min-w-0">
      <span className="block truncate font-medium">{name}</span>
      <span className="block truncate text-[10px] opacity-60">{meta}</span>
    </span>
  );

  // Images and video open the viewer; an audio player is the preview itself, so
  // clicking through to a larger copy of the same controls would be pointless.
  if (displayUrl && kind === "image") {
    return (
      <button type="button" onClick={() => onOpen?.(attachment)} className="block w-full min-w-48 overflow-hidden border p-1.5 text-start text-xs hover:brightness-95" style={surface}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={displayUrl} alt={name} className="mb-1.5 block max-h-44 w-full object-cover" style={{ borderRadius: Math.max(4, component.radius - 4) }} />
        {caption}
      </button>
    );
  }
  if (displayUrl && kind === "video") {
    return (
      <span className="block w-full min-w-48 overflow-hidden border p-1.5 text-xs" style={surface}>
        <video src={displayUrl} controls preload="metadata" className="mb-1.5 block max-h-44 w-full bg-black object-contain" style={{ borderRadius: Math.max(4, component.radius - 4) }} />
        <button type="button" onClick={() => onOpen?.(attachment)} className="block w-full text-start hover:opacity-80">{caption}</button>
      </span>
    );
  }
  if (displayUrl && kind === "audio") {
    return (
      <span className="block w-full min-w-48 border p-2 text-xs" style={surface}>
        <span className="mb-1.5 flex min-w-0 items-center gap-2.5">
          <span className="grid shrink-0 place-items-center" style={{ width: component.iconSize + 16, height: component.iconSize + 16, borderRadius: Math.max(6, component.radius - 3), background: config.theme.colors.surface }}>
            <WidgetIcon name={component.documentIcon} fallback="file-text" size={component.iconSize} />
          </span>
          {caption}
        </span>
        <audio src={displayUrl} controls preload="metadata" className="block w-full" />
      </span>
    );
  }

  const contents = (
    <span className="flex min-w-0 items-center gap-2.5">
      <span
        className="grid shrink-0 place-items-center overflow-hidden"
        style={{
          width: component.iconSize + 16,
          height: component.iconSize + 16,
          borderRadius: Math.max(6, component.radius - 3),
          background: config.theme.colors.surface,
        }}
      >
        <WidgetIcon name={component.documentIcon} fallback="file-text" size={component.iconSize} />
      </span>
      {caption}
    </span>
  );
  return onOpen && displayUrl ? (
    <button type="button" onClick={() => onOpen(attachment)} className="block w-full min-w-48 border p-2 text-start text-xs hover:brightness-95" style={surface}>{contents}</button>
  ) : (
    <span className="block min-w-48 border p-2 text-xs" style={surface}>{contents}</span>
  );
}

function initialPreviewMessages(previewScenario, previewAgent = null, locale = "en-US") {
  const ui = widgetTranslations(locale);
  const now = new Date().toISOString();
  const agentName = previewAgent?.userName || null;
  if (previewScenario === "handoff") {
    return [
      { id: "preview-user", role: "user", content: ui.preview.handoffRequest, createdAt: now, deliveryStatus: "delivered" },
      { id: "preview-human", role: "human", content: ui.preview.humanReply, createdAt: now, agentName },
    ];
  }
  return [
    { id: "preview-user", role: "user", content: ui.preview.userOrder, createdAt: now, deliveryStatus: "delivered" },
    { id: "preview-assistant", role: "assistant", content: ui.preview.assistantReply, createdAt: now, attachments: [{ id: "preview-image", filename: "order-photo.jpg", mediaType: "image/jpeg", size: "1.8 MB" }] },
    { id: "preview-human", role: "human", content: ui.preview.humanReply, createdAt: now, agentName, attachments: [{ id: "preview-document", filename: "return-form.pdf", mediaType: "application/pdf", size: "248 KB" }] },
  ];
}

function localDateValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftedLocalDate(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return localDateValue(date);
}

function previewCallbackSlots(date, callbackConfig) {
  const [startHour, startMinute] = callbackConfig.availabilityWindowStart.split(":").map(Number);
  const [endHour, endMinute] = callbackConfig.availabilityWindowEnd.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const step = callbackConfig.scheduleStepMinutes;
  return Array.from({ length: Math.max(0, Math.ceil((end - start) / step)) }, (_, index) => {
    const minute = start + index * step;
    const label = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    return {
      label,
      startsAt: new Date(`${date}T${label}:00`).toISOString(),
      callbackAtUtc: new Date(`${date}T${label}:00`).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z"),
      available: true,
      booked: 0,
    };
  });
}

function CallbackForm({ widget, config, preview, sessionToken }) {
  const callbackConfig = widget.callbacks;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const requestIdRef = useRef(null);
  const [form, setForm] = useState({
    firstName: "", lastName: "", phoneNumber: "", email: "", topicKey: callbackConfig.topics?.[0]?.key || "",
    description: "", mode: callbackConfig.allowImmediate ? "immediate" : "scheduled", consentPhone: false, consentSms: false, consentEmail: false,
  });
  const [scheduledDate, setScheduledDate] = useState(() => localDateValue());
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [availability, setAvailability] = useState({ status: "idle", slots: [], message: "" });
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const update = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  useEffect(() => {
    if (form.mode !== "scheduled" || !scheduledDate) return undefined;
    setSelectedSlot(null);
    if (preview) {
      setAvailability({ status: "ready", slots: previewCallbackSlots(scheduledDate, callbackConfig), message: "" });
      return undefined;
    }
    const controller = new AbortController();
    setAvailability({ status: "loading", slots: [], message: "" });
    const query = new URLSearchParams({ date: scheduledDate, timeZone });
    fetch(`/api/widgets/${encodeURIComponent(widget.id)}/callbacks?${query}`, {
      headers: { Authorization: `Bearer ${sessionToken || widget.bootstrapToken}` },
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Unable to load callback times");
      setAvailability({ status: "ready", slots: result.slots || [], message: "" });
    }).catch((error) => {
      if (error.name !== "AbortError") setAvailability({ status: "error", slots: [], message: error.message });
    });
    return () => controller.abort();
  }, [callbackConfig, form.mode, preview, scheduledDate, sessionToken, timeZone, widget.bootstrapToken, widget.id]);
  const submit = async (event) => {
    event.preventDefault();
    setStatus("submitting");
    setMessage("");
    try {
      if (preview) {
        setStatus("succeeded");
        setMessage("Callback request preview submitted.");
        return;
      }
      if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
      const response = await fetch(`/api/widgets/${encodeURIComponent(widget.id)}/callbacks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken || widget.bootstrapToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: requestIdRef.current, firstName: form.firstName, lastName: form.lastName,
          phoneNumber: form.phoneNumber, email: form.email, topicKey: form.topicKey,
          description: form.description, mode: form.mode,
          ...(form.mode === "scheduled" && selectedSlot ? { scheduledAtUtc: selectedSlot.startsAt || selectedSlot.callbackAtUtc } : {}),
          timeZone, locale: config.locale, consentPhone: form.consentPhone,
          consentSms: form.consentSms, consentEmail: form.consentEmail,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Unable to schedule the callback");
      setStatus("succeeded");
      setMessage(`Callback requested for ${new Intl.DateTimeFormat(config.locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(result.callback.callbackAtUtc))}.`);
    } catch (error) {
      setStatus("error");
      setMessage(error.message);
    }
  };
  // Fields inherit no border colour of their own, so they were rendering as bare
  // text on the panel background. Every control is themed explicitly instead.
  const fieldStyle = {
    backgroundColor: config.theme.colors.inputBackground,
    color: config.theme.colors.inputText,
    borderColor: config.theme.colors.border,
    borderRadius: config.theme.shape.inputRadius,
  };
  const chipStyle = (selected) => selected
    ? {
        backgroundColor: config.theme.colors.primary,
        color: config.theme.colors.onPrimary,
        borderColor: config.theme.colors.primary,
        borderRadius: config.theme.shape.buttonRadius,
      }
    : {
        backgroundColor: config.theme.colors.surface,
        color: config.theme.colors.text,
        borderColor: config.theme.colors.border,
        borderRadius: config.theme.shape.buttonRadius,
      };
  const legendStyle = { color: config.theme.colors.mutedText };
  const inputClass = "w-full border px-3 py-2.5 text-sm outline-none transition-shadow focus:ring-2";
  const Label = ({ children, required: isRequired = true }) => (
    <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide" style={legendStyle}>
      {children}{isRequired && <span aria-hidden="true"> *</span>}
    </span>
  );

  if (status === "succeeded") {
    return (
      <div className="m-auto grid max-w-sm gap-4 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-full" style={{ backgroundColor: config.theme.colors.primary, color: config.theme.colors.onPrimary }}>
          <WidgetIcon name="calendar-check" fallback="check" size={28} />
        </span>
        <h2 className="text-lg font-semibold">{callbackConfig.copy.successTitle}</h2>
        <p className="text-sm opacity-70">{message}</p>
      </div>
    );
  }

  return <form className="grid gap-5" onSubmit={submit}>
    <div>
      <h2 className="font-semibold" style={{ fontSize: config.theme.typography.titleSize }}>{callbackConfig.copy.title}</h2>
      <p className="mt-0.5 text-xs" style={legendStyle}>Times shown in {timeZone}</p>
    </div>

    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block min-w-0">
          <Label>{callbackConfig.copy.firstNameLabel}</Label>
          <input required className={inputClass} style={fieldStyle} autoComplete="given-name" value={form.firstName} onChange={(event) => update("firstName", event.target.value)} />
        </label>
        <label className="block min-w-0">
          <Label>{callbackConfig.copy.lastNameLabel}</Label>
          <input required className={inputClass} style={fieldStyle} autoComplete="family-name" value={form.lastName} onChange={(event) => update("lastName", event.target.value)} />
        </label>
      </div>
      <label className="block">
        <Label>{callbackConfig.copy.phoneLabel}</Label>
        <input required className={inputClass} style={fieldStyle} type="tel" inputMode="tel" autoComplete="tel" placeholder="+48 123 456 789" value={form.phoneNumber} onChange={(event) => update("phoneNumber", event.target.value)} />
      </label>
      <label className="block">
        <Label>{callbackConfig.copy.emailLabel}</Label>
        <input required className={inputClass} style={fieldStyle} type="email" inputMode="email" autoComplete="email" value={form.email} onChange={(event) => update("email", event.target.value)} />
      </label>
    </div>

    <div className="grid gap-3">
      <div role="group" aria-label={callbackConfig.copy.topicLabel}>
        <Label>{callbackConfig.copy.topicLabel}</Label>
        <div className="flex flex-wrap gap-2">
          {(callbackConfig.topics || []).map((topic) => (
            <button
              key={topic.key}
              type="button"
              aria-pressed={form.topicKey === topic.key}
              className="border px-3 py-2 text-sm font-medium transition-colors"
              style={chipStyle(form.topicKey === topic.key)}
              onClick={() => update("topicKey", topic.key)}
            >
              {topic.label}
            </button>
          ))}
        </div>
      </div>
      <label className="block">
        <Label>{callbackConfig.copy.descriptionLabel}</Label>
        <textarea required maxLength={512} rows={3} className={`${inputClass} resize-y`} style={fieldStyle} value={form.description} onChange={(event) => update("description", event.target.value)} />
        <span className="mt-1 block text-end text-[10px] tabular-nums" style={legendStyle}>{form.description.length}/512</span>
      </label>
    </div>

    {callbackConfig.allowImmediate && callbackConfig.allowScheduled && (
      <div role="group" aria-label={callbackConfig.copy.scheduleAtLabel}>
        {/* The date field below carries the label; repeating it here read as a
            duplicated heading. */}
        <div className="grid grid-cols-2 gap-1 border p-1" style={{ borderColor: config.theme.colors.border, borderRadius: config.theme.shape.buttonRadius, backgroundColor: config.theme.colors.surfaceMuted }}>
          {[
            { value: "immediate", label: callbackConfig.copy.immediateLabel },
            { value: "scheduled", label: callbackConfig.copy.scheduledLabel },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={form.mode === option.value}
              className="px-3 py-2 text-sm font-medium transition-colors"
              style={form.mode === option.value
                ? { backgroundColor: config.theme.colors.primary, color: config.theme.colors.onPrimary, borderRadius: Math.max(2, config.theme.shape.buttonRadius - 2) }
                : { color: config.theme.colors.mutedText, borderRadius: Math.max(2, config.theme.shape.buttonRadius - 2) }}
              onClick={() => update("mode", option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    )}

    {form.mode === "immediate" && (
      <p className="flex items-start gap-2 border px-3 py-2.5 text-xs" style={{ borderColor: config.theme.colors.border, borderRadius: config.theme.shape.buttonRadius, backgroundColor: config.theme.colors.surfaceMuted, color: config.theme.colors.mutedText }}>
        <WidgetIcon name="info" fallback="info" size={14} className="mt-0.5 shrink-0" />
        <span>The next free {callbackConfig.scheduleStepMinutes}-minute slot between {callbackConfig.availabilityWindowStart} and {callbackConfig.availabilityWindowEnd} will be used.</span>
      </p>
    )}

    {form.mode === "scheduled" && (
      <div className="grid gap-3 border p-3" style={{ borderColor: config.theme.colors.border, borderRadius: config.theme.shape.buttonRadius }}>
        <label className="block">
          <Label>{callbackConfig.copy.scheduleAtLabel}</Label>
          <input required className={inputClass} style={fieldStyle} type="date" min={shiftedLocalDate(0)} max={shiftedLocalDate(callbackConfig.maximumScheduleDays)} value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} />
        </label>
        <div className="flex items-baseline justify-between gap-2 text-[11px]" style={legendStyle}>
          <span>Available {callbackConfig.scheduleStepMinutes}-minute slots</span>
          <span className="tabular-nums">{callbackConfig.availabilityWindowStart}–{callbackConfig.availabilityWindowEnd}</span>
        </div>
        {availability.status === "loading" && (
          <p className="grid place-items-center gap-2 py-6 text-xs" style={legendStyle}>
            <span className="block size-5 rounded-full border-2 border-current border-t-transparent opacity-40 motion-safe:animate-spin" />
            Loading available times…
          </p>
        )}
        {availability.status === "error" && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{availability.message}</p>}
        {availability.status === "ready" && Boolean(availability.slots.length) && (
          <div className="grid max-h-44 grid-cols-3 gap-2 overflow-y-auto pr-0.5">
            {availability.slots.map((slot) => (
              <button
                key={slot.callbackAtUtc}
                type="button"
                disabled={!slot.available}
                aria-pressed={selectedSlot?.callbackAtUtc === slot.callbackAtUtc}
                className="border px-1 py-2 text-xs font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-35"
                style={chipStyle(selectedSlot?.callbackAtUtc === slot.callbackAtUtc)}
                onClick={() => setSelectedSlot(slot)}
              >
                <span className="block">{slot.label}</span>
                {slot.unavailableReason === "full" && <span className="block text-[9px] font-normal">Full</span>}
              </button>
            ))}
          </div>
        )}
        {availability.status === "ready" && !availability.slots.some(({ available }) => available) && (
          <p className="text-xs" style={legendStyle}>No free slots on this day. Pick another date.</p>
        )}
        <input className="sr-only" tabIndex={-1} required value={selectedSlot?.callbackAtUtc || ""} onChange={() => undefined} aria-label="Selected callback time" />
      </div>
    )}

    <div className="grid gap-2.5 border p-3" style={{ borderColor: config.theme.colors.border, borderRadius: config.theme.shape.buttonRadius, backgroundColor: config.theme.colors.surfaceMuted }}>
      <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-snug">
        <input required type="checkbox" className="mt-0.5 size-4 shrink-0 accent-current" style={{ accentColor: config.theme.colors.primary }} checked={form.consentPhone} onChange={(event) => update("consentPhone", event.target.checked)} />
        <span>{callbackConfig.consentText}</span>
      </label>
      {(callbackConfig.showSmsConsent || callbackConfig.showEmailConsent) && (
        <div className="flex flex-wrap gap-4 text-xs" style={legendStyle}>
          {callbackConfig.showSmsConsent && (
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="size-4 accent-current" style={{ accentColor: config.theme.colors.primary }} checked={form.consentSms} onChange={(event) => update("consentSms", event.target.checked)} />
              SMS
            </label>
          )}
          {callbackConfig.showEmailConsent && (
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="size-4 accent-current" style={{ accentColor: config.theme.colors.primary }} checked={form.consentEmail} onChange={(event) => update("consentEmail", event.target.checked)} />
              Email
            </label>
          )}
        </div>
      )}
    </div>

    {message && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{message}</p>}

    <button
      disabled={status === "submitting" || !form.consentPhone}
      type="submit"
      className="w-full px-4 py-3 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
      style={{ backgroundColor: config.theme.colors.primary, color: config.theme.colors.onPrimary, borderRadius: config.theme.shape.buttonRadius }}
    >
      {status === "submitting" ? "Scheduling…" : callbackConfig.copy.submitLabel}
    </button>
  </form>;
}

function HomeSurface({ config, callbacks, surfaces, onSelect, edgeInsets }) {
  const { colors } = config.theme;
  const cards = [
    surfaces.includes("messaging") && {
      key: "messaging",
      icon: "message-circle",
      fallback: "message-circle",
      background: colors.primary,
      foreground: colors.onPrimary,
      title: config.content.chatLabel,
      description: config.content.messagingSubtitle,
    },
    surfaces.includes("voice") && {
      key: "voice",
      icon: "phone",
      fallback: "phone",
      background: config.components.launcher.backgroundColor,
      foreground: config.components.launcher.textColor,
      title: config.content.callLabel,
      description: config.content.voiceSubtitle,
    },
    surfaces.includes("video") && {
      key: "video",
      icon: "video",
      fallback: "video",
      background: colors.primary,
      foreground: colors.onPrimary,
      title: config.content.videoLabel,
      description: config.content.videoSubtitle,
    },
    surfaces.includes("callbacks") && {
      key: "callbacks",
      icon: "calendar-clock",
      fallback: "calendar",
      background: colors.primary,
      foreground: colors.onPrimary,
      title: callbacks?.copy?.buttonLabel,
      description: callbacks?.copy?.title,
    },
  ].filter(Boolean);
  return (
    <div className="grid gap-3">
      {cards.map((card) => (
        <button
          key={card.key}
          type="button"
          onClick={() => onSelect(card.key)}
          className="flex w-full items-center gap-3 border p-4 text-start"
          style={{ borderColor: colors.border, borderRadius: config.theme.shape.buttonRadius, backgroundColor: colors.surfaceMuted, marginInlineStart: edgeInsets.left ? 0 : undefined }}
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-full" style={{ backgroundColor: card.background, color: card.foreground }}>
            <WidgetIcon name={card.icon} fallback={card.fallback} size={19} />
          </span>
          <span className="min-w-0">
            <strong className="block truncate">{card.title}</strong>
            <small className="block truncate opacity-65">{card.description}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

export default function WidgetFrame({
  previewWidget,
  previewMode = "messaging",
  previewScenario = null,
  onPreviewClose,
  onPreviewHome,
}) {
  const [runtimePayload, setRuntimePayload] = useState(null);
  const [sessionToken, setSessionToken] = useState(null);
  const pendingCustomerMessageRef = useRef(null);
  const [messages, setMessages] = useState(previewWidget ? initialPreviewMessages(previewScenario, previewWidget.previewAgent, previewWidget.config?.locale) : []);
  const [input, setInput] = useState("");
  const [chatStatus, setChatStatus] = useState(previewWidget ? "preview" : "idle");
  const [chatError, setChatError] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [handoff, setHandoff] = useState(null);
  const [callbackOpen, setCallbackOpen] = useState(Boolean(previewWidget && previewScenario === "callbacks"));
  const [runtimeSurface, setRuntimeSurface] = useState(null);
  const [greeting, setGreeting] = useState("");
  const [panelHidden, setPanelHidden] = useState(false);
  const [restartCount, setRestartCount] = useState(0);
  const unreadRef = useRef(0);
  const customerTypingLastSentRef = useRef(0);
  const [previewedAttachment, setPreviewedAttachment] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const messageInputRef = useRef(null);
  const restoreMessageInputFocusRef = useRef(false);
  const startedRef = useRef(false);
  const clientKeyRef = useRef(null);
  const messagesEndRef = useRef(null);
  const scrollRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const payload = useMemo(
    () => previewWidget ? { widget: previewWidget, mode: previewMode } : runtimePayload,
    [previewMode, previewWidget, runtimePayload]
  );
  const config = payload?.widget?.config;
  const ui = widgetTranslations(config?.locale);
  const direction = widgetDirection(config?.locale);
  // The panel opens on the surface the launcher picked; the home button then
  // navigates between the surfaces this widget offers without closing the panel.
  const surfaces = [
    config?.channels.messaging.enabled && "messaging",
    config?.channels.voice.enabled && "voice",
    config?.channels.video?.enabled && "video",
    payload?.widget?.callbacks?.enabled && "callbacks",
  ].filter(Boolean);
  const activeSurface = (previewWidget ? null : runtimeSurface) || payload?.mode;
  const mode = activeSurface === "callbacks" ? "messaging" : activeSurface || "messaging";
  const edgeInsets = previewWidget?.edgeToEdge && previewWidget.edgeInsets
    ? previewWidget.edgeInsets
    : { top: 0, right: 0, bottom: 0, left: 0 };
  const previewHandoff = previewWidget && previewScenario === "handoff" && config
    ? {
        status: "connected",
        queueName: config.channels.messaging.routing.queueName || config.channels.messaging.routing.queues?.[0]?.name || ui.preview.fallbackQueue,
        agentName: "Anna Kowalska",
      }
    : null;
  const visibleHandoff = handoff || previewHandoff;
  // An agent leaving ends the conversation: Contact Center tore the interaction down, so
  // the composer closes rather than silently failing or falling back to the bot.
  const conversationEnded = ["disconnected", "completed"].includes(handoff?.status);
  const firstAgentMessageIndex = messages.findIndex((message) => message.role === "human");
  const handoffTimelineIndex = firstAgentMessageIndex === -1 ? messages.length : firstAgentMessageIndex;

  useEffect(() => {
    if (!restoreMessageInputFocusRef.current || chatStatus !== "ready") return undefined;
    const frame = window.requestAnimationFrame(() => {
      const messageInput = messageInputRef.current;
      if (!messageInput || messageInput.disabled) return;
      messageInput.focus({ preventScroll: true });
      restoreMessageInputFocusRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chatStatus]);

  const isStudioPreview = Boolean(previewWidget), previewAgent = previewWidget?.previewAgent, previewLocale = previewWidget?.config?.locale;
  useEffect(() => {
    if (!isStudioPreview) return;
    setMessages(initialPreviewMessages(previewScenario, previewAgent, previewLocale));
    setCallbackOpen(previewScenario === "callbacks");
  }, [previewScenario, isStudioPreview, previewAgent, previewLocale]);

  useEffect(() => {
    if (previewWidget) return;
    const parentOrigin = new URLSearchParams(window.location.search).get("parentOrigin");
    const onMessage = (event) => {
      if (parentOrigin && event.origin !== parentOrigin) return;
      if (event.data?.type === "telnyx-widget-config") {
        setRuntimePayload({ widget: event.data.widget, mode: event.data.mode });
        setCallbackOpen(event.data.mode === "callbacks");
      }
      // The loader keeps this panel alive but hidden after a close so replies that
      // land meanwhile can be counted on the launcher badge.
      if (event.data?.type === "telnyx-widget-visibility") {
        setPanelHidden(!event.data.visible);
        if (event.data.visible) unreadRef.current = 0;
      }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "telnyx-widget-ready" }, parentOrigin || "*");
    return () => window.removeEventListener("message", onMessage);
  }, [previewWidget]);

  const sessionStorageKey = useMemo(() => {
    if (typeof window === "undefined" || !payload?.widget?.id) return null;
    const parentOrigin = new URLSearchParams(window.location.search).get("parentOrigin") || "unknown";
    return `telnyx-widget-session:${payload.widget.id}:${parentOrigin}`;
  }, [payload?.widget?.id]);

  useEffect(() => {
    const widget = payload?.widget;
    if (previewWidget || mode !== "messaging" || !widget?.bootstrapToken || startedRef.current) {
      return;
    }
    startedRef.current = true;
    clientKeyRef.current ||= crypto.randomUUID();
    let cancelled = false;
    const storageKey = sessionStorageKey;
    const persisted = widget.config.behavior.persistSession && widget.config.behavior.reopenBehavior === "resume"
      ? window.localStorage.getItem(storageKey)
      : null;

    async function start() {
      setChatStatus("connecting");
      try {
        const freshWidget = await requestFreshWidgetBootstrap(widget.id);
        const response = await fetch(`/api/widgets/${encodeURIComponent(widget.id)}/sessions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${freshWidget.bootstrapToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: "messaging",
            clientKey: clientKeyRef.current,
            context: freshWidget.decisionContext || widget.decisionContext || {},
            ...(persisted ? { sessionToken: persisted } : {}),
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Nie udało się rozpocząć rozmowy");
        if (cancelled) return;
        setSessionToken(result.sessionToken);
        setMessages(Array.isArray(result.messages) ? result.messages : []);
        setGreeting(String(result.greeting || ""));
        setChatStatus(result.session?.status === "starting" ? "connecting" : "ready");
        setHandoff(result.handoff || null);
        // The loader only keeps this panel alive after a close when there is a
        // conversation left to receive replies; the surface it opened with says
        // nothing about that, because the customer navigates inside the panel.
        window.parent.postMessage(
          { type: "telnyx-widget-session", active: true },
          parentTargetOrigin()
        );
        if (widget.config.behavior.persistSession) {
          window.localStorage.setItem(storageKey, result.sessionToken);
        } else {
          window.localStorage.removeItem(storageKey);
        }
      } catch {
        if (cancelled) return;
        if (persisted) window.localStorage.removeItem(storageKey);
        setChatError(widget.config.content.unavailableMessage);
        setChatStatus("error");
      }
    }
    start();
    return () => {
      cancelled = true;
    };
  }, [mode, payload, previewWidget, restartCount, sessionStorageKey]);

  useEffect(() => {
    if (!sessionToken || previewWidget || mode !== "messaging") return;
    let cancelled = false;
    let timer;
    async function poll() {
      let nextDelay = 2500;
      try {
        const response = await fetch("/api/widget-sessions/state", {
          headers: { Authorization: `Bearer ${sessionToken}` },
          cache: "no-store",
        });
        const result = await response.json().catch(() => ({}));
        if (!cancelled && [401,403].includes(response.status)) {
          setHandoff({status:"disconnected"});
          setChatError(payload?.widget?.config?.content?.unavailableMessage || "This chat session has ended.");
          return;
        }
        if (!cancelled && response.ok) {
          setHandoff(result.handoff || null);
          if (result.runtimeKind === "ai_chat") {
            setGreeting(String(result.greeting || ""));
            setChatStatus(current => result.session?.status === "starting" ? "connecting" : current === "connecting" ? "ready" : current);
          }
          if (["assigned", "connected"].includes(result.handoff?.status)) nextDelay = 1000;
          if (Array.isArray(result.messages) && result.messages.length) {
            setMessages((current) => {
              const merged = mergeMessages(current, result.messages);
              if (panelHidden && merged.length > current.length) {
                unreadRef.current += merged.length - current.length;
                const parentOrigin = parentTargetOrigin();
                window.parent.postMessage(
                  { type: "telnyx-widget-unread", count: unreadRef.current },
                  parentOrigin
                );
              }
              return merged;
            });
          }
        }
      } catch {
        // A transient polling error must not interrupt the active chat session.
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, nextDelay);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, panelHidden, previewWidget, sessionToken, payload?.widget?.config?.content?.unavailableMessage]);

  useEffect(() => {
    if (previewWidget || !conversationEnded) return;
    if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
    window.parent.postMessage(
      { type: "telnyx-widget-session", active: false },
      new URLSearchParams(window.location.search).get("parentOrigin") || "*"
    );
  }, [conversationEnded, previewWidget, sessionStorageKey]);

  useEffect(() => {
    if (
      previewWidget
      || !sessionToken
      || handoff?.status !== "connected"
      || !config?.components.messages.agentTypingIndicator.sendCustomerTyping
      || !input.trim()
    ) return undefined;

    const elapsed = Date.now() - customerTypingLastSentRef.current;
    const delay = Math.max(0, 2500 - elapsed);
    const timer = window.setTimeout(() => {
      customerTypingLastSentRef.current = Date.now();
      void fetch("/api/widget-sessions/typing", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ typing: true }),
      }).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [config, handoff?.status, input, previewWidget, sessionToken]);

  useEffect(() => {
    // Polling refreshes state every few seconds; scrolling back down then would
    // yank the customer away from the history they scrolled up to read.
    if (!stickToBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, chatStatus]);

  // The viewer lives inside the embedded frame, so showing a document larger than
  // the panel means asking the loader to grow that frame over the host page.
  const previewSettings = config?.components.attachments.preview;
  const expandPreviewOverPage = previewSettings?.placement === "page";

  useEffect(() => {
    if (previewWidget || !expandPreviewOverPage) return;
    const parentOrigin = new URLSearchParams(window.location.search).get("parentOrigin") || "*";
    window.parent.postMessage(
      previewedAttachment
        ? {
            type: "telnyx-widget-expand",
            widthPercent: previewSettings.pageWidthPercent,
            heightPercent: previewSettings.pageHeightPercent,
          }
        : { type: "telnyx-widget-collapse" },
      parentOrigin
    );
  }, [
    expandPreviewOverPage,
    previewSettings?.pageHeightPercent,
    previewSettings?.pageWidthPercent,
    previewWidget,
    previewedAttachment,
  ]);

  const onTranscriptScroll = (event) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    stickToBottomRef.current = scrollHeight - scrollTop - clientHeight <= 48;
  };

  const frameStyle = useMemo(
    () =>
      config
        ? {
            backgroundColor: config.theme.colors.surface,
            color: config.theme.colors.text,
            borderColor: config.theme.colors.border,
            borderRadius: previewWidget?.edgeToEdge ? 0 : config.theme.shape.panelRadius,
            borderWidth: previewWidget?.edgeToEdge ? 0 : undefined,
            fontFamily: `"${config.theme.typography.fontFamily}", ui-sans-serif, system-ui, sans-serif`,
            fontSize: config.theme.typography.baseSize,
          }
        : {},
    [config, previewWidget?.edgeToEdge]
  );

  if (!config) {
    return <div className="grid min-h-screen place-items-center bg-transparent text-sm">{ui.aria.loading}</div>;
  }

  const close = () => {
    if (previewWidget) {
      onPreviewClose?.();
      return;
    }
    if (sessionToken && config.behavior.reopenBehavior === "new") {
      if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
      void fetch("/api/widget-sessions/disconnect", {method:"POST",keepalive:true,
        headers:{Authorization:`Bearer ${sessionToken}`}}).catch(()=>undefined);
    }
    window.parent.postMessage({ type: "telnyx-widget-close" }, parentTargetOrigin());
  };

  const home = () => {
    if (previewWidget) {
      onPreviewHome?.();
      return;
    }
    if (surfaces.length > 1) {
      setRuntimeSurface("home");
      setCallbackOpen(false);
      return;
    }
    window.parent.postMessage({ type: "telnyx-widget-home" }, parentTargetOrigin());
  };

  const openSurface = (surface) => {
    setRuntimeSurface(surface);
    setCallbackOpen(surface === "callbacks");
  };

  if (mode === "video") {
    return (
      <VideoWidgetRuntime
        widget={payload.widget}
        preview={Boolean(previewWidget)}
        previewScenario={previewWidget ? previewScenario : null}
        onClose={close}
        onHome={home}
      />
    );
  }

  if (mode === "voice") {
    return (
      <VoiceWidgetRuntime
        widget={payload.widget}
        preview={Boolean(previewWidget)}
        onClose={close}
        onHome={home}
      />
    );
  }

  const sendMessage = async (event) => {
    event.preventDefault();
    const content = input.trim();
    const chatReady = Boolean(previewWidget) || (chatStatus === "ready" && !conversationEnded);
    if (!content || !chatReady) return;
    restoreMessageInputFocusRef.current = true;
    const optimisticId = pendingCustomerMessageRef.current?.content === content ? pendingCustomerMessageRef.current.id : crypto.randomUUID();
    pendingCustomerMessageRef.current = {id:optimisticId,content};
    setInput("");
    setMessages((current) => [
      ...current,
      { id: optimisticId, role: "user", content, createdAt: new Date().toISOString() },
    ]);
    if (previewWidget || !sessionToken) {
      window.requestAnimationFrame(() => {
        messageInputRef.current?.focus({ preventScroll: true });
        restoreMessageInputFocusRef.current = false;
      });
      return;
    }
    setChatStatus("sending");
    setChatError("");
    try {
      const response = await fetch("/api/widget-sessions/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content, messageId: optimisticId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if(response.status<500)pendingCustomerMessageRef.current=null;
        throw new Error(result.error || "Nie udało się wysłać wiadomości");
      }
      pendingCustomerMessageRef.current=null;
      setMessages(current=>current.map(message=>message.id===optimisticId?{...message,deliveryStatus:result.pendingReply?"pending":"delivered"}:message));
      if (result.handoff) setHandoff(result.handoff);
      if (result.message?.content) {
        setMessages((current) => [...current, result.message]);
      } else if (!result.handoff) {
        const historyResponse = await fetch("/api/widget-sessions/messages", {
          headers: { Authorization: `Bearer ${sessionToken}` },
          cache: "no-store",
        });
        const history = await historyResponse.json().catch(() => ({}));
        if (historyResponse.ok && Array.isArray(history.messages)) setMessages(history.messages);
      }
      setChatStatus("ready");
    } catch {
      setMessages((current) => current.filter((message) => message.id !== optimisticId));
      setInput(content);
      setChatError(config.content.sendFailedMessage);
      setChatStatus("ready");
    }
  };

  const chatReady = Boolean(previewWidget) || (chatStatus === "ready" && !conversationEnded);
  const startNewConversation = () => {
    if (previewWidget) return;
    if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
    startedRef.current = false;
    clientKeyRef.current = null;
    unreadRef.current = 0;
    customerTypingLastSentRef.current = 0;
    setHandoff(null);
    setMessages([]);
    setGreeting("");
    setInput("");
    setChatError("");
    setSessionToken(null);
    setChatStatus("connecting");
    setRestartCount((current) => current + 1);
  };
  // The runtime waits for the assistant greeting so the configured copy never
  // flashes first; the preview has no live assistant and keeps using that copy.
  const openingMessage = previewWidget ? config.content.welcomeMessage : greeting;
  // Customer files travel over Contact Center Open Messaging, which only exists once the
  // conversation reached a human agent.
  const handoffAcceptsFiles = !conversationEnded
    && ["waiting", "assigned", "connected"].includes(handoff?.status);
  const attachmentsReady = previewWidget
    ? true
    : chatStatus === "ready" && handoffAcceptsFiles && !uploading
      && config.features.attachmentPolicy.inboundMimeTypes.length > 0;

  const uploadAttachment = async (file) => {
    if (!file || !sessionToken) return;
    const maximumBytes = config.features.attachmentPolicy.maximumFileSizeMb * 1_048_576;
    if (!isAttachmentTypeAllowed(file.type, file.name, config.features.attachmentPolicy.inboundMimeTypes)) {
      setChatError(ui.preview.attachmentTypeRejected);
      return;
    }
    if (file.size > maximumBytes) {
      setChatError(ui.preview.attachmentTooLarge.replace("{limit}", config.features.attachmentPolicy.maximumFileSizeMb));
      return;
    }
    setUploading(true);
    setChatError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("messageId", crypto.randomUUID());
      const response = await fetch("/api/widget-sessions/attachments", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
        body,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || ui.preview.attachmentFailed);
      if (result.message) setMessages((current) => mergeMessages(current, [result.message]));
    } catch (error) {
      setChatError(error.message || ui.preview.attachmentFailed);
    } finally {
      setUploading(false);
    }
  };
  const footer = config.components.footer;
  const previewAttachment = (mediaType) => {
    if (!previewWidget) return;
    const image = mediaType.startsWith("image/");
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: image ? ui.preview.photoAttached : ui.preview.documentAttached,
        createdAt: new Date().toISOString(),
        deliveryStatus: "delivered",
        attachments: [{
          id: crypto.randomUUID(),
          filename: image ? "sample-image.png" : mediaType === "application/pdf" ? "sample-document.pdf" : "sample-file.txt",
          mediaType,
          size: image ? "1.2 MB" : "320 KB",
        }],
      },
    ]);
    setAttachmentMenuOpen(false);
  };

  return (
    <main lang={config.locale} dir={direction} className={`flex flex-col overflow-hidden border ${previewWidget ? "h-full min-h-0" : "h-dvh min-h-[420px]"}`} style={frameStyle}>
      <header
        className={`flex shrink-0 items-center gap-3 border-b ${config.components.header.alignment === "center" ? "text-center" : "text-start"}`}
        style={{
          minHeight: config.dimensions.headerHeight + edgeInsets.top,
          paddingTop: edgeInsets.top,
          paddingLeft: config.dimensions.headerPaddingX + edgeInsets.left,
          paddingRight: config.dimensions.headerPaddingX + edgeInsets.right,
          backgroundColor: config.theme.colors.headerBackground,
          color: config.theme.colors.headerText,
          borderColor: config.theme.colors.border,
        }}
      >
        {config.components.header.showIcon && <Avatar spec={{ type: "icon", value: config.components.header.icon }} color={config.theme.colors.primary} textColor={config.theme.colors.onPrimary} size={config.components.header.iconSize} />}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold" style={{ fontSize: config.theme.typography.titleSize }}>{config.content.title}</h1>
          {config.components.header.showDescription && <p className="truncate opacity-65" style={{ fontSize: config.theme.typography.descriptionSize }}>
            {mode === "voice" ? config.content.voiceSubtitle : config.content.messagingSubtitle}
          </p>}
        </div>
        {(previewWidget || (surfaces.length > 1 && mode !== "home")) && (
          <button type="button" onClick={home} className="rounded-full p-2 hover:bg-black/5" aria-label={ui.aria.home}>
            <WidgetIcon name="home" fallback="home" size={19} />
          </button>
        )}
        {config.components.header.showClose && (
          <button type="button" onClick={close} className="rounded-full p-2 hover:bg-black/5" aria-label={ui.aria.close}>
            <WidgetIcon name={config.components.header.closeIcon} fallback="x" size={19} />
          </button>
        )}
      </header>

      <section
        ref={scrollRef}
        onScroll={onTranscriptScroll}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
        style={{ paddingLeft: 16 + edgeInsets.left, paddingRight: 16 + edgeInsets.right }}
      >
        {mode === "home"
          ? <HomeSurface config={config} callbacks={payload.widget.callbacks} surfaces={surfaces} onSelect={openSurface} edgeInsets={edgeInsets} />
          : callbackOpen && payload.widget.callbacks?.enabled
          ? <CallbackForm widget={payload.widget} config={config} preview={Boolean(previewWidget)} sessionToken={sessionToken} />
          : <>
        {openingMessage && (
          <div className="flex items-end gap-2">
            <div style={{ maxWidth: `${config.dimensions.messageMaxWidth}%` }}>
              {config.components.messages.showParticipantNames && <p className="mb-1 px-1" style={{ color: config.theme.colors.mutedText, fontSize: config.theme.typography.participantSize }}>{config.components.messages.assistantLabel}</p>}
              <p className="px-4 py-3" style={{ backgroundColor: config.theme.colors.assistantBubble, color: config.theme.colors.assistantText, borderRadius: config.theme.shape.bubbleRadius, fontSize: config.theme.typography.messageSize }}>{openingMessage}</p>
            </div>
          </div>
        )}

        {mode === "messaging" && (
          <div className="mt-4 grid" style={{ gap: config.components.messages.spacing }}>
            {messages.map((message, index) => {
              const customer = message.role === "user";
              const human = message.role === "human";
              return (
                <Fragment key={message.id || `${message.role}-${index}-${message.createdAt}`}>
                {visibleHandoff && handoffTimelineIndex === index && (
                  <HandoffTimeline config={config} handoff={visibleHandoff} ui={ui} previewAll={Boolean(previewHandoff)} />
                )}
                <div
                  className={`flex items-end gap-2 ${customer ? "justify-end" : "justify-start"}`}
                >
                  {config.components.messages.showAvatars && !customer && (
                    human ? (
                      <HumanAvatar
                        config={config}
                        message={message}
                        sessionToken={sessionToken}
                        previewAgent={previewWidget?.previewAgent}
                      />
                    ) : (
                      <Avatar
                        spec={config.avatars.bot}
                        color={config.theme.colors.primary}
                        textColor={config.theme.colors.onPrimary}
                        size={config.components.messages.avatarSize}
                      />
                    )
                  )}
                  <div className={customer ? "text-end" : "text-start"} style={{ maxWidth: `${config.dimensions.messageMaxWidth}%` }}>
                    {config.components.messages.showParticipantNames && (
                      <p className="mb-1 px-1" style={{ color: config.theme.colors.mutedText, fontSize: config.theme.typography.participantSize }}>
                        {customer
                          ? config.components.messages.customerLabel
                          : human
                            ? message.agentName || visibleHandoff?.agentName || config.components.messages.humanLabel
                            : config.components.messages.assistantLabel}
                      </p>
                    )}
                    <div
                      className="whitespace-pre-wrap px-4 py-3 text-start"
                      style={{
                        borderRadius: config.theme.shape.bubbleRadius,
                        backgroundColor: customer ? config.theme.colors.customerBubble : human ? config.theme.colors.humanBubble : config.theme.colors.assistantBubble,
                        color: customer ? config.theme.colors.customerText : human ? config.theme.colors.humanText : config.theme.colors.assistantText,
                        fontSize: config.theme.typography.messageSize,
                      }}
                    >
                      {customer ? (
                        message.content
                      ) : (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ children, ...props }) => <a {...props} className="underline" target="_blank" rel="noreferrer">{children}</a>,
                            p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
                          }}
                        >
                          {message.content}
                        </ReactMarkdown>
                      )}
                      {Array.isArray(message.attachments) && message.attachments.length > 0 && (!previewWidget || config.features.attachmentPolicy.showPreviewExamples) && (
                        <div className="mt-2 grid gap-1.5">
                          {message.attachments.map((attachment, attachmentIndex) => (
                            <AttachmentCard key={attachment.id || attachment.url || attachmentIndex} attachment={attachment} config={config} ui={ui} onOpen={setPreviewedAttachment} />
                          ))}
                        </div>
                      )}
                    </div>
                    {config.components.messages.showTimestamps && message.createdAt && (
                      <time className="mt-1 block px-1 opacity-55" style={{ color: config.theme.colors.mutedText, fontSize: config.theme.typography.metaSize }}>
                        {new Intl.DateTimeFormat(config.locale, {
                          hour: "2-digit",
                          minute: "2-digit",
                        }).format(new Date(message.createdAt))}{customer && config.components.messages.showDeliveryStatus ? ` · ${message.deliveryStatus === "delivered" ? ui.preview.delivered : config.content.sendingMessage}` : ""}
                      </time>
                    )}
                  </div>
                  {config.components.messages.showAvatars && customer && (
                    <Avatar spec={config.avatars.customer} color={config.theme.colors.customerBubble} textColor={config.theme.colors.customerText} size={config.components.messages.avatarSize} />
                  )}
                </div>
                </Fragment>
              );
            })}
            {/* The timeline belongs where the conversation actually changed hands:
                just before the first agent reply, or at the end while still queued. */}
            {visibleHandoff && handoffTimelineIndex === messages.length && (
              <HandoffTimeline config={config} handoff={visibleHandoff} ui={ui} previewAll={Boolean(previewHandoff)} />
            )}
            {visibleHandoff && (
              <HandoffTimeline config={config} handoff={visibleHandoff} ui={ui} previewAll={Boolean(previewHandoff)} phase="closing" />
            )}
            {(chatStatus === "connecting" || (chatStatus === "sending" && handoff)) && (
              <p className="text-center text-xs opacity-55">
                {chatStatus === "connecting"
                  ? config.content.connectingMessage
                  : config.content.sendingMessage}
              </p>
            )}
            <AssistantThinkingBadge
              active={
                (chatStatus === "sending" && !handoff)
                || Boolean(previewWidget && previewScenario === "typing")
              }
              config={config}
            />
            <AgentTypingBadge
              config={config}
              agentName={visibleHandoff?.agentName}
              typingUntil={handoff?.agentTypingUntil}
              previewActive={Boolean(previewWidget && previewScenario === "typing")}
            />
            {chatError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{chatError}</p>}
            <div ref={messagesEndRef} />
          </div>
        )}
        </>}
      </section>

      {mode === "messaging" && !callbackOpen && (
        <footer
          className="shrink-0 border-t"
          style={{
            minHeight: config.dimensions.footerHeight + edgeInsets.bottom,
            paddingTop: 10,
            paddingBottom: 10 + edgeInsets.bottom,
            paddingLeft: config.dimensions.footerPaddingX + edgeInsets.left,
            paddingRight: config.dimensions.footerPaddingX + edgeInsets.right,
            borderColor: config.theme.colors.border,
            backgroundColor: config.theme.colors.footerBackground,
            color: config.theme.colors.footerText,
          }}
        >
          {conversationEnded && !previewWidget ? (
            <button
              type="button"
              onClick={startNewConversation}
              className="w-full font-medium transition-opacity hover:opacity-90"
              style={{
                height: footer.buttonSize,
                backgroundColor: footer.buttonBackgroundColor,
                color: footer.buttonTextColor,
                borderRadius: config.theme.shape.buttonRadius,
                fontSize: config.theme.typography.messageSize,
              }}
            >
              {ui.actions.startNewConversation}
            </button>
          ) : (
          <>
          {config.features.emoji && emojiOpen && mode === "messaging" && (
            <div className="mb-2 flex flex-wrap gap-1 rounded-xl border border-black/10 bg-white p-2 shadow-sm">
              {QUICK_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-lg hover:bg-black/5"
                  onClick={() => {
                    setInput((current) => `${current}${emoji}`);
                    setEmojiOpen(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
          {attachmentMenuOpen && previewWidget && (
            <div className="mb-2 rounded-xl border bg-background p-2 shadow-sm" style={{ borderColor: config.components.attachments.borderColor }}>
              <p className="mb-2 px-1 text-[11px] font-medium text-muted-foreground">{ui.preview.simulateAttachment}</p>
              <div className="grid max-h-32 grid-cols-2 gap-1 overflow-y-auto">
                {config.features.attachmentPolicy.inboundMimeTypes.map((mediaType) => (
                      <button key={mediaType} type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-start text-xs hover:bg-muted" onClick={() => previewAttachment(mediaType)}>
                    <WidgetIcon name={mediaType.startsWith("image/") ? config.components.attachments.imageIcon : config.components.attachments.documentIcon} size={16} />
                    <span className="min-w-0 truncate">{mediaType}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <form className="flex items-center" onSubmit={sendMessage}>
            {(config.features.attachmentsAfterHandoff || config.features.emoji) && (
                  <div className="flex shrink-0 items-center" style={{ gap: footer.utilityButtonGap, marginInlineEnd: footer.utilityInputGap }}>
                {config.features.attachmentsAfterHandoff && (
                  <>
                    {!previewWidget && (
                      <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        accept={attachmentAccept(config.features.attachmentPolicy.inboundMimeTypes)}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          void uploadAttachment(file);
                        }}
                      />
                    )}
                    <button
                      type="button"
                      disabled={!attachmentsReady}
                      onClick={() => previewWidget
                        ? setAttachmentMenuOpen((current) => !current)
                        : fileInputRef.current?.click()}
                      className="grid shrink-0 place-items-center rounded-full transition-colors hover:bg-black/5 disabled:opacity-35"
                      style={{ width: footer.buttonSize, height: footer.buttonSize }}
                      aria-label={ui.aria.attachFile}
                      title={previewWidget || handoffAcceptsFiles ? ui.aria.attachFile : ui.aria.attachmentUnavailable}
                    >
                      <WidgetIcon name={uploading ? "sparkles" : footer.attachmentIcon} fallback="paperclip" size={footer.iconSize} className={uploading ? "motion-safe:animate-spin" : undefined} />
                    </button>
                  </>
                )}
                {config.features.emoji && mode === "messaging" && (
                  <button
                    type="button"
                    disabled={!chatReady}
                    onClick={() => setEmojiOpen((current) => !current)}
                    className="grid shrink-0 place-items-center rounded-full transition-colors hover:bg-black/5 disabled:opacity-35"
                    style={{ width: footer.buttonSize, height: footer.buttonSize }}
                    aria-label={ui.aria.emoji}
                  >
                    <WidgetIcon name={footer.emojiIcon} fallback="smile" size={footer.iconSize} />
                  </button>
                )}
              </div>
            )}
            <input
              ref={messageInputRef}
              disabled={mode !== "messaging" || !chatReady}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              maxLength={8000}
              autoFocus={config.behavior.autoFocusInput && !previewWidget}
              className="min-w-0 flex-1 border px-4 outline-none transition-shadow focus:ring-2 disabled:opacity-60"
              style={{ height: footer.buttonSize, backgroundColor: config.theme.colors.inputBackground, color: config.theme.colors.inputText, borderColor: config.theme.colors.border, borderRadius: config.theme.shape.inputRadius, fontSize: config.theme.typography.messageSize }}
              placeholder={config.content.inputPlaceholder}
              aria-label={config.content.inputPlaceholder}
            />
            <button
              disabled={mode !== "messaging" || !chatReady || !input.trim()}
              type="submit"
              className="grid place-items-center disabled:opacity-50"
                  style={{ width: footer.buttonSize, height: footer.buttonSize, marginInlineStart: footer.inputSendGap, backgroundColor: footer.buttonBackgroundColor, color: footer.buttonTextColor, borderRadius: config.theme.shape.buttonRadius }}
              aria-label={ui.aria.send}
            >
              <WidgetIcon name={footer.sendIcon} fallback="send" size={footer.iconSize} />
            </button>
          </form>
          </>
          )}
        </footer>
      )}

      <AttachmentPreviewModal
        attachment={previewedAttachment}
        config={config}
        ui={ui}
        expanded={expandPreviewOverPage}
        onClose={() => setPreviewedAttachment(null)}
      />
    </main>
  );
}
