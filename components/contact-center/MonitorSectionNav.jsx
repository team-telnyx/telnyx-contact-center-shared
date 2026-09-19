"use client";

import { useRouter } from "next/navigation";
import {
  IconActivity,
  IconMessages,
  IconTrendingUp,
  IconUsers,
  IconLayoutDashboard,
  IconShieldCheck,
} from "@tabler/icons-react";
import { SectionRail } from "@/components/ui/section-rail";

// Single source of truth for the supervisor monitor left rail. The monitor
// page renders these sections inline. Call History now lives in the Analytics
// workspace, and the old Statistics tab was consolidated into the Dashboard.
export const MONITOR_ACTIVE_SECTION_STORAGE_KEY =
  "supervisor.monitor.activeSection";

export const MONITOR_RAIL_ITEMS = [
  { id: "overview", label: "Overview", icon: IconLayoutDashboard, description: "Live queue workload, agent presence and operational status" },
  { id: "dashboard", label: "Dashboard", icon: IconActivity, description: "Channel performance, service levels and trends for a selected period" },
  { id: "agents", label: "Agents", icon: IconUsers, description: "Agent status and live interactions" },
  { id: "queues", label: "Queues", icon: IconTrendingUp, description: "Queue performance and waiting interactions" },
  { id: "interactions", label: "Interactions", icon: IconMessages, description: "All live interactions, manual calls and consultation legs" },
  { id: "operations", label: "Operations", icon: IconShieldCheck, description: "Voice platform health and audited recovery" },
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
      screenGroup="supervisor.monitor"
    />
  );
}
