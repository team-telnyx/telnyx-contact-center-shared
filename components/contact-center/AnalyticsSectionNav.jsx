"use client";

import { useRouter } from "next/navigation";
import {
  IconArrowBounce,
  IconClockPause,
  IconHistory,
  IconPhoneOff,
  IconPuzzle,
  IconRobot,
  IconSpeakerphone,
  IconTag,
  IconTrendingUp,
  IconUsers,
} from "@tabler/icons-react";
import { SectionRail } from "@/components/ui/section-rail";

// Single source of truth for the supervisor analytics left rail. The analytics
// page renders these sections inline; sub-pages (call history list/detail)
// render the same rail and navigate back into analytics with the chosen
// section persisted so the left panel never disappears during navigation.
export const ANALYTICS_ACTIVE_SECTION_STORAGE_KEY =
  "supervisor.analytics.activeSection";

export const ANALYTICS_RAIL_ITEMS = [
  { id: "queue-performance", label: "Queue Performance", icon: IconTrendingUp, description: "Historical queue volumes, SLA, and handle times" },
  { id: "agent-performance", label: "Agent Scorecard", icon: IconUsers, description: "Agent handled volume, AHT, holds, transfers, occupancy" },
  { id: "abandonment", label: "Abandonment", icon: IconPhoneOff, description: "Abandon rates, wait distribution, and callback list" },
  { id: "agent-adherence", label: "Adherence", icon: IconClockPause, description: "Agent status mix, logins, breaks, and recent transitions" },
  { id: "transfers-holds", label: "Transfers & Holds", icon: IconArrowBounce, description: "Transfer and hold pressure by agent and queue" },
  { id: "wrapup-codes", label: "Wrap-up Codes", icon: IconTag, description: "Why customers call — disposition mix and coverage" },
  { id: "ai-handoffs", label: "AI Handoffs", icon: IconRobot, description: "AI assistant to agent handoffs, outcomes, and health" },
  { id: "outbound-campaigns", label: "Outbound", icon: IconSpeakerphone, description: "Campaign attempts, connect rates, and failure reasons" },
  { id: "skills-gap", label: "Skills Gap", icon: IconPuzzle, description: "Skill supply vs demand and queue coverage" },
  { id: "call-history", label: "Call History", icon: IconHistory, description: "Historical interactions, recordings, and workflow details" },
];

export function persistAnalyticsSection(sectionId) {
  try {
    localStorage.setItem(ANALYTICS_ACTIVE_SECTION_STORAGE_KEY, sectionId);
  } catch {
    // Ignore storage errors so navigation still works without persisted UI state.
  }
}

export function AnalyticsSectionRailNav({ activeId = "call-history" }) {
  const router = useRouter();
  return (
    <SectionRail
      items={ANALYTICS_RAIL_ITEMS}
      activeId={activeId}
      onSelect={(sectionId) => {
        persistAnalyticsSection(sectionId);
        router.push(`/supervisor/analytics?section=${encodeURIComponent(sectionId)}`);
      }}
      ariaLabel="Supervisor analytics reports"
    />
  );
}
