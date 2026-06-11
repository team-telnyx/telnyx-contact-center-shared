"use client";

import {
  IconDashboard,
  IconList,
  IconSettings,
} from "@tabler/icons-react";
import { SectionRail } from "@/components/ui/section-rail";

export const CALL_GENERATOR_ACTIVE_SECTION_STORAGE_KEY =
  "admin.call-generator.activeSection";

export const CALL_GENERATOR_RAIL_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconDashboard, description: "Live runs, active calls, and metrics" },
  { id: "scenarios", label: "Scenarios", icon: IconList, description: "Create and manage test call scenarios" },
  { id: "settings", label: "Settings", icon: IconSettings, description: "Global call generator configuration" },
];

export function persistCallGeneratorSection(sectionId) {
  try {
    localStorage.setItem(CALL_GENERATOR_ACTIVE_SECTION_STORAGE_KEY, sectionId);
  } catch {
    // Ignore storage errors.
  }
}
