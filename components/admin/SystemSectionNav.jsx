"use client";

import { useRouter } from "next/navigation";
import { IconBug, IconDashboard, IconDeviceLandlinePhone, IconLogout, IconPalette, IconPhoneCall } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { SectionRail, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { useExperimentalFeatures } from "@/lib/experimental-features-client";

export const SYSTEM_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconDashboard, href: "/admin/system/dashboard", description: "Review configuration inventory, integrations, and platform activity." },
  { id: "call-generator", label: "Call Generator", icon: IconPhoneCall, href: "/admin/call-generator", description: "Create controlled call scenarios, actions, and test runs." },
  { id: "logging", label: "Logging", icon: IconBug, href: "/admin/logging", description: "Inspect live runtime events, log files, and logging policies." },
  { id: "phones-provisioning", label: "Phones Provisioning", icon: IconDeviceLandlinePhone, href: "/admin/phones-provisioning", description: "Manage hardphone inventory, bridges, and provisioning status." },
  { id: "theme-settings", label: "Theme Settings", icon: IconPalette, href: "/settings", description: "Customize branding, application colors, and authentication visuals." },
];

export const SYSTEM_EXIT_ITEM = {
  id: "exit",
  label: "Exit",
  icon: IconLogout,
  description: "Return to System",
  tone: "exit",
};

export function visibleSystemItems(experimentalFeaturesEnabled) {
  return experimentalFeaturesEnabled
    ? SYSTEM_ITEMS
    : SYSTEM_ITEMS.filter((item) => item.id !== "phones-provisioning");
}

export function SystemSectionPage({ activeId, children, contentClassName }) {
  const router = useRouter();
  const { enabled: experimentalFeaturesEnabled } = useExperimentalFeatures();
  const items = visibleSystemItems(experimentalFeaturesEnabled);

  function navigate(id) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) router.push(item.href);
  }

  return (
    <main
      className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3"
      style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}
    >
      <SectionRail items={items} activeId={activeId} onSelect={navigate} ariaLabel="System sections" />
      <section className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden", contentClassName)}>{children}</section>
    </main>
  );
}
