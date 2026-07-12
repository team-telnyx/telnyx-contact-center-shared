"use client";

import { useRouter } from "next/navigation";
import { IconBook2, IconBrain, IconCalendar, IconRobot, IconServer, IconTools } from "@tabler/icons-react";
import { SectionRail, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";

const AI_SECTION_ITEMS = [
  { id: "assistants", label: "AI Assistants", icon: IconRobot, href: "/admin/ai-assistants", description: "Manage AI assistants" },
  { id: "tools", label: "Tools Library", icon: IconTools, href: "/admin/tools-library", description: "Manage reusable assistant tools" },
  { id: "insights", label: "Insights", icon: IconBrain, href: "/admin/insights", description: "Manage conversation insights" },
  { id: "scheduled-events", label: "Scheduled Events", icon: IconCalendar, href: "/supervisor/scheduled-events", description: "Manage scheduled assistant interactions" },
  { id: "pronunciation-dictionaries", label: "Pronunciation Dictionaries", icon: IconBook2, href: "/admin/ai-assistants/pronunciation-dictionaries", description: "Manage assistant pronunciation dictionaries" },
  { id: "mcp-servers", label: "MCP Servers", icon: IconServer, href: "/admin/mcp-servers", description: "Manage MCP server connections" },
];

export function AiAssistantsSectionPage({ activeId, children }) {
  const router = useRouter();

  function navigate(id) {
    const item = AI_SECTION_ITEMS.find((candidate) => candidate.id === id);
    if (item) router.push(item.href);
  }

  return (
    <main
      className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3"
      style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}
    >
      <SectionRail items={AI_SECTION_ITEMS} activeId={activeId} onSelect={navigate} ariaLabel="AI Assistants sections" />
      <section className="min-h-0 min-w-0 overflow-y-auto pr-1">{children}</section>
    </main>
  );
}
