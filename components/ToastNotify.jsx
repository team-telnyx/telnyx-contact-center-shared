"use client";

import { useEffect, useState } from "react";

const DEFAULT_DURATION_MS = 5000;
const toastListeners = new Set();

function createToastId() {
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function variantDotClass(variant) {
  if (variant === "success") return "bg-green-500";
  if (variant === "error") return "bg-red-500";
  if (variant === "warning") return "bg-yellow-500";
  return "bg-blue-500";
}

function emitToastEvent(event) {
  for (const listener of toastListeners) listener(event);
}

export function dismissNotify(id) {
  emitToastEvent({ type: "dismiss", id });
}

export function notify({
  title,
  description,
  variant = "info",
  onConfirm,
  autoCloseMs,
}) {
  const duration =
    typeof autoCloseMs === "number"
      ? autoCloseMs > 0
        ? autoCloseMs
        : Infinity
      : DEFAULT_DURATION_MS;
  const id = createToastId();

  emitToastEvent({
    type: "add",
    toast: {
      id,
      title,
      description,
      variant,
      onConfirm,
      duration,
    },
  });

  return id;
}

function ToastCard({ toast }) {
  useEffect(() => {
    if (toast.duration === Infinity) return undefined;
    const timeout = window.setTimeout(() => dismissNotify(toast.id), toast.duration);
    return () => window.clearTimeout(timeout);
  }, [toast.duration, toast.id]);

  return (
    <div className="rounded-md border shadow-md w-[400px] max-w-[calc(100vw-2rem)] bg-[#f3f3f3] text-foreground dark:bg-neutral-800 animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div className="p-3">
        <div className="flex items-start gap-3">
          <div className={`h-2.5 w-2.5 rounded-full mt-2 ${variantDotClass(toast.variant)}`} />
          <div className="flex-1 min-w-0">
            <div className="font-medium">{toast.title}</div>
            {toast.description && (
              <div className="text-sm text-muted-foreground mt-1 break-words">
                {toast.description}
              </div>
            )}
          </div>
        </div>
      </div>
      {toast.duration === Infinity && (
        <div className="border-t p-3 flex justify-end">
          <button
            className="px-3 py-1 text-sm rounded-md bg-neutral-200 dark:bg-neutral-700"
            onClick={() => {
              dismissNotify(toast.id);
              toast.onConfirm?.();
            }}
          >
            OK
          </button>
        </div>
      )}
    </div>
  );
}

export function Toaster({ position = "bottom-right" }) {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const listener = (event) => {
      if (event.type === "add") {
        setToasts((current) => [event.toast, ...current].slice(0, 5));
      } else if (event.type === "dismiss") {
        setToasts((current) => current.filter((toast) => toast.id !== event.id));
      }
    };

    toastListeners.add(listener);
    return () => toastListeners.delete(listener);
  }, []);

  if (!toasts.length) return null;

  const verticalClass = position.startsWith("top") ? "top-4" : "bottom-4";
  const horizontalClass = position.endsWith("left") ? "left-4" : "right-4";

  return (
    <div className={`fixed z-[9999] ${verticalClass} ${horizontalClass} flex flex-col gap-3 pointer-events-none`}>
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastCard toast={toast} />
        </div>
      ))}
    </div>
  );
}
