"use client";

import { useRouter } from "next/navigation";
import {
  IconActivity,
  IconChartBar,
  IconHistory,
  IconTrendingUp,
  IconUsers,
} from "@tabler/icons-react";
import { SectionRail } from "@/components/ui/section-rail";

// Single source of truth for the supervisor monitor left rail. The monitor
// page renders these sections inline; sub-pages (call history list/detail)
// render the same rail and navigate back into the monitor with the chosen
// section persisted so the left panel never disappears during navigation.
export const MONITOR_ACTIVE_SECTION_STORAGE_KEY =
  "supervisor.monitor.activeSection";

export const MONITOR_RAIL_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconActivity, description: "Live workspace overview" },
  { id: "agents", label: "Agents", icon: IconUsers, description: "Agent status and live calls" },
  { id: "queues", label: "Queues", icon: IconTrendingUp, description: "Queue performance and waiting calls" },
  { id: "graphs", label: "Statistics", icon: IconChartBar, description: "Live reporting snapshots" },
  { id: "call-history", label: "Call History", icon: IconHistory, description: "Historical interactions, recordings, and workflow details" },
];

export function persistMonitorSection(sectionId) {
  try {
    localStorage.setItem(MONITOR_ACTIVE_SECTION_STORAGE_KEY, sectionId);
  } catch {
    // Ignore storage errors so navigation still works without persisted UI state.
  }
}

export function MonitorSectionRailNav({ activeId = "call-history" }) {
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
