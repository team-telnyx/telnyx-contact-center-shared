"use client";

import { useRouter } from "next/navigation";
import {
  IconActivity,
  IconTrendingUp,
  IconUsers,
} from "@tabler/icons-react";
import { SectionRail } from "@/components/ui/section-rail";

// Single source of truth for the supervisor monitor left rail. The monitor
// page renders these sections inline. Call History now lives in the Analytics
// workspace, and the old Statistics tab was consolidated into the Dashboard.
export const MONITOR_ACTIVE_SECTION_STORAGE_KEY =
  "supervisor.monitor.activeSection";

export const MONITOR_RAIL_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconActivity, description: "Today's contact center picture and live signals" },
  { id: "agents", label: "Agents", icon: IconUsers, description: "Agent status and live calls" },
  { id: "queues", label: "Queues", icon: IconTrendingUp, description: "Queue performance and waiting calls" },
];

export function persistMonitorSection(sectionId) {
  try {
    localStorage.setItem(MONITOR_ACTIVE_SECTION_STORAGE_KEY, sectionId);
  } catch {
    // Ignore storage errors so navigation still works without persisted UI state.
  }
}

export function MonitorSectionRailNav({ activeId = "dashboard" }) {
  const router = useRouter();
  return (
    <SectionRail
      items={MONITOR_RAIL_ITEMS}
      activeId={activeId}
      onSelect={(sectionId) => {
        persistMonitorSection(sectionId);
        router.push(`/supervisor/monitor?section=${encodeURIComponent(sectionId)}`);
      }}
      ariaLabel="Supervisor monitor sections"
    />
  );
}
