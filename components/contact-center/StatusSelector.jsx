"use client";

import { useState, useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconClock, IconX } from "@tabler/icons-react";
import {
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
} from "@/config/status-icons";

function formatPendingSince(value) {
  const time = value ? new Date(value) : null;
  if (!time || Number.isNaN(time.getTime())) return "";
  return ` (chosen at ${time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
}

// `value` is the effective status (Busy while interactions are open).
// `pendingStatus` is the manual status the agent already chose; it applies once
// the current interactions end and keeps new interactions from being offered.
export function StatusSelector({ value, onChange, pendingStatus = null, pendingSince = null }) {
  const [selectableStatuses, setSelectableStatuses] = useState([]);
  const [allStatuses, setAllStatuses] = useState([]); // All statuses for display metadata
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStatuses() {
      try {
        const res = await fetch("/api/user/statuses", {
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          const allStatusesData = data.statuses || [];
          // Store all statuses for display metadata (icon, color)
          setAllStatuses(allStatusesData);
          // Filter to only show user-selectable statuses in the dropdown
          // Non-selectable statuses (like Offline, Busy) are set by the system and shouldn't appear in the list
          const selectable = allStatusesData.filter(
            (status) => status.user_selectable !== false,
          );
          setSelectableStatuses(selectable);
        } else {
          // Fallback to default statuses if API fails
          console.error("[StatusSelector] Failed to load statuses");
          const fallback = [
            { name: "Available", user_selectable: true },
            { name: "Away", user_selectable: true },
          ];
          setAllStatuses(fallback);
          setSelectableStatuses(fallback);
        }
      } catch (error) {
        console.error("[StatusSelector] Error loading statuses:", error);
        // Fallback to default statuses (only user-selectable ones)
        const fallback = [
          { name: "Available", user_selectable: true },
          { name: "Away", user_selectable: true },
        ];
        setAllStatuses(fallback);
        setSelectableStatuses(fallback);
      } finally {
        setLoading(false);
      }
    }

    loadStatuses();
  }, []);

  // Get status metadata for current value (even if non-selectable)
  const currentStatusMeta = allStatuses.find((s) => s.name === value) || null;

  // Build options list: include selectable statuses + current value if it's non-selectable
  const optionsForDisplay = [...selectableStatuses];
  if (
    value &&
    currentStatusMeta &&
    currentStatusMeta.user_selectable === false
  ) {
    // Add current non-selectable status to options so it can be displayed
    // Check if it's not already in the list
    if (!optionsForDisplay.some((s) => s.name === value)) {
      optionsForDisplay.push(currentStatusMeta);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={value || undefined}
        onValueChange={(nextValue) => {
          // Only allow changes to selectable statuses
          const selectedStatus = allStatuses.find((s) => s.name === nextValue);
          if (selectedStatus && selectedStatus.user_selectable !== false) {
            onChange?.(nextValue);
          }
        }}
        disabled={loading}
      >
        <SelectTrigger data-testid="agent-status" data-status={value || ""} className="w-[280px]">
          <SelectValue placeholder={loading ? "Loading..." : "Select status"} />
        </SelectTrigger>
        <SelectContent>
          {optionsForDisplay.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              No statuses available
            </div>
          ) : (
            optionsForDisplay.map((status) => {
              const Icon =
                STATUS_ICON_MAP[status.icon] ||
                STATUS_NAME_ICON_FALLBACK[status.name] ||
                STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
              const isSelectable = status.user_selectable !== false;
              return (
                <SelectItem
                  key={status.name}
                  data-testid="agent-status-option" data-status={status.name}
                  value={status.name}
                  disabled={!isSelectable}
                >
                  <div className="flex items-center gap-2">
                    <Icon
                      className="h-4 w-4"
                      style={status.color ? { color: status.color } : undefined}
                    />
                    <span>{status.name}</span>
                    {pendingStatus && status.name === pendingStatus && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <IconClock className="h-3.5 w-3.5" aria-hidden="true" />
                        pending
                      </span>
                    )}
                    {pendingStatus && status.name === "Available" && (
                      <span className="text-xs text-muted-foreground">cancels {pendingStatus}</span>
                    )}
                  </div>
                </SelectItem>
              );
            })
          )}
        </SelectContent>
      </Select>
      {pendingStatus && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="agent-status-pending"
              data-status={pendingStatus}
              className="inline-flex h-8 cursor-default items-center gap-1 rounded-md border border-dashed border-amber-500/70 pl-2 pr-1 text-xs font-medium text-amber-700 dark:text-amber-300"
            >
              <IconClock className="h-3.5 w-3.5" aria-hidden="true" />
              {pendingStatus}
              {/* Available is always accepted while busy; it simply clears the waiting status. */}
              <button
                type="button"
                data-testid="agent-status-pending-cancel"
                aria-label={`Cancel pending ${pendingStatus} and stay Available`}
                title="Cancel and stay Available"
                onClick={() => onChange?.("Available")}
                className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-sm hover:bg-amber-500/20"
              >
                <IconX className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {pendingStatus} applies once your current interactions end{formatPendingSince(pendingSince)}.
            No new interactions are offered meanwhile. Click the cross to cancel and stay Available.
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
