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
  IconCheck,
  IconClock,
  IconX,
  IconCircleOff,
} from "@tabler/icons-react";

// Icon mapping for common status names
const STATUS_ICON_MAP = {
  Available: IconCheck,
  "On Queue": IconClock,
  Busy: IconX,
  Away: IconCircleOff,
  "Off Queue": IconCircleOff,
  Offline: IconCircleOff,
  Break: IconClock,
};

// Default icon if status name doesn't match
const DefaultIcon = IconCircleOff;

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

  return (
    <div className="flex items-center gap-2">
      <Select value={value} onValueChange={onChange} disabled={loading}>
        <SelectTrigger className="w-[280px]">
          <SelectValue placeholder={loading ? "Loading..." : "Select status"} />
        </SelectTrigger>
        <SelectContent>
          {statuses.map((status) => {
            const Icon = STATUS_ICON_MAP[status.name] || DefaultIcon;
            return (
              <SelectItem key={status.name} value={status.name}>
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4" />
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
