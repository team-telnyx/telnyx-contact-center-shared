"use client";

import { toast } from "sonner";

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
      : undefined;

  const id = toast.custom(
    (t) => (
      <div className="rounded-md border shadow-md w-[400px] bg-[#f3f3f3] text-foreground dark:bg-neutral-800">
        <div className="p-3">
          <div className="flex items-start gap-3">
            <div
              className={`h-2.5 w-2.5 rounded-full mt-2 ${
                variant === "success"
                  ? "bg-green-500"
                  : variant === "error"
                  ? "bg-red-500"
                  : variant === "warning"
                  ? "bg-yellow-500"
                  : "bg-blue-500"
              }`}
            />
            <div className="flex-1">
              <div className="font-medium">{title}</div>
              {description && (
                <div className="text-sm text-muted-foreground mt-1">
                  {description}
                </div>
              )}
            </div>
          </div>
        </div>
        {duration === Infinity && (
          <div className="border-t p-3 flex justify-end">
            <button
              className="px-3 py-1 text-sm rounded-md bg-neutral-200  dark:bg-neutral-700"
              onClick={() => {
                toast.dismiss(t);
                onConfirm?.();
              }}
            >
              OK
            </button>
          </div>
        )}
      </div>
    ),
    { duration }
  );
}
