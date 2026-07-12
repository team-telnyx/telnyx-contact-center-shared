"use client";

import { useRouter } from "next/navigation";
import { IconForms, IconGitBranch, IconRoute } from "@tabler/icons-react";
import { SectionRail, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";

const AUTOMATION_ITEMS = [
  { id: "call-app-flows", label: "Call & App Flows", icon: IconRoute, href: "/admin/call-flows" },
  { id: "workflows", label: "Workflows", icon: IconGitBranch, href: "/admin/workflows" },
  { id: "forms", label: "Forms", icon: IconForms, href: "/admin/forms" },
];

export function AutomationsSectionPage({ activeId, children, onNavigate }) {
  const router = useRouter();

  function navigate(id) {
    const item = AUTOMATION_ITEMS.find((candidate) => candidate.id === id);
    if (!item) return;
    if (onNavigate) {
      onNavigate(item.href);
      return;
    }
    router.push(item.href);
  }

  return (
    <main
      className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3"
      style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}
    >
      <SectionRail items={AUTOMATION_ITEMS} activeId={activeId} onSelect={navigate} ariaLabel="Automations sections" />
      <section className="min-h-0 min-w-0 overflow-y-auto pr-1">{children}</section>
    </main>
  );
}
