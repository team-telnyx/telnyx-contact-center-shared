"use client";

import { useState, useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
} from "@/config/status-icons";

export function StatusSelector({ value, onChange }) {
  const [statuses, setStatuses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStatuses() {
      try {
        const res = await fetch("/api/user/statuses", {
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          setStatuses(data.statuses || []);
        } else {
          // Fallback to default statuses if API fails
          console.error("[StatusSelector] Failed to load statuses");
          setStatuses([
            { name: "Available" },
            { name: "Busy" },
            { name: "Away" },
            { name: "Offline" },
          ]);
        }
      } catch (error) {
        console.error("[StatusSelector] Error loading statuses:", error);
        // Fallback to default statuses
        setStatuses([
          { name: "Available" },
          { name: "Busy" },
          { name: "Away" },
          { name: "Offline" },
        ]);
      } finally {
        setLoading(false);
      }
    }

    loadStatuses();
  }, []);

  useEffect(() => {
    if (!value) return;
    setStatuses((prev) => {
      if (prev.some((status) => status.name === value)) return prev;
      return [
        ...prev,
        {
          name: value,
          user_selectable: false,
        },
      ];
    });
  }, [value]);

  const statusesByName = statuses.reduce((acc, status) => {
    if (status?.name) acc[status.name] = status;
    return acc;
  }, {});

  return (
    <div className="flex items-center gap-2">
      <Select
        value={value}
        onValueChange={(nextValue) => {
          const nextStatus = statusesByName[nextValue];
          if (nextStatus && nextStatus.user_selectable === false) return;
          onChange?.(nextValue);
        }}
        disabled={loading}
      >
        <SelectTrigger className="w-[280px]">
          <SelectValue placeholder={loading ? "Loading..." : "Select status"} />
        </SelectTrigger>
        <SelectContent>
          {statuses.map((status) => {
            const Icon =
              STATUS_ICON_MAP[status.icon] ||
              STATUS_NAME_ICON_FALLBACK[status.name] ||
              STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
            return (
              <SelectItem
                key={status.name}
                value={status.name}
                disabled={status.user_selectable === false}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className="h-4 w-4"
                    style={status.color ? { color: status.color } : undefined}
                  />
                  <span>{status.name}</span>
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
