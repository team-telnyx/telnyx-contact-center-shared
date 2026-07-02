"use client";

import { useRouter } from "next/navigation";
import {
  IconChecklist,
  IconClipboardCheck,
  IconGauge,
} from "@tabler/icons-react";
import { SectionRail } from "@/components/ui/section-rail";

// Single source of truth for the supervisor quality management left rail.
// The quality page renders these sections inline; the evaluation detail page
// renders the same rail and navigates back with the section persisted.
export const QUALITY_ACTIVE_SECTION_STORAGE_KEY =
  "supervisor.quality.activeSection";

export const QUALITY_RAIL_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconGauge, description: "Quality scores, AI vs human evaluations, and trends" },
  { id: "evaluations", label: "Evaluations", icon: IconChecklist, description: "Conversations to review with recordings and AI drafts" },
  { id: "forms", label: "Forms", icon: IconClipboardCheck, description: "Evaluation scorecards and templates" },
];

export function persistQualitySection(sectionId) {
  try {
    localStorage.setItem(QUALITY_ACTIVE_SECTION_STORAGE_KEY, sectionId);
  } catch {
    // Ignore storage errors so navigation still works without persisted UI state.
  }
}

export function QualitySectionRailNav({ activeId = "evaluations" }) {
  const router = useRouter();
  return (
    <SectionRail
      items={QUALITY_RAIL_ITEMS}
      activeId={activeId}
      onSelect={(sectionId) => {
        persistQualitySection(sectionId);
        router.push(`/supervisor/quality?section=${encodeURIComponent(sectionId)}`);
      }}
      ariaLabel="Supervisor quality management sections"
    />
  );
}
