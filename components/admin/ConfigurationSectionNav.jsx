"use client";

import { useRouter } from "next/navigation";
import {
  IconAddressBook,
  IconAward,
  IconDatabase,
  IconFileMusic,
  IconKey,
  IconList,
  IconPhone,
  IconTag,
  IconUsers,
  IconWorld,
} from "@tabler/icons-react";
import { SectionRail, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";

const CONFIGURATION_ITEMS = [
  { id: "users", label: "Users", icon: IconUsers, href: "/admin/users" },
  { id: "queues", label: "Queues", icon: IconList, href: "/admin/queues" },
  { id: "skills", label: "Skills", icon: IconAward, href: "/admin/skills" },
  { id: "statuses", label: "Statuses", icon: IconTag, href: "/admin/statuses" },
  { id: "wrapup-codes", label: "Wrapup Codes", icon: IconAddressBook, href: "/admin/wrapup-codes" },
  { id: "numbers", label: "Numbers", icon: IconPhone, href: "/admin/numbers" },
  { id: "data-sources", label: "Data Sources", icon: IconDatabase, href: "/admin/data-sources" },
  { id: "web-pages", label: "Web Pages", icon: IconWorld, href: "/admin/web-pages" },
  { id: "media-library", label: "Media Library", icon: IconFileMusic, href: "/admin/media-library" },
  { id: "domains", label: "Domains", icon: IconWorld, href: "/admin/domains" },
  { id: "secrets", label: "Secrets", icon: IconKey, href: "/admin/secrets" },
];

export function ConfigurationSectionPage({ activeId, children }) {
  const router = useRouter();

  function navigate(id) {
    const item = CONFIGURATION_ITEMS.find((candidate) => candidate.id === id);
    if (item) router.push(item.href);
  }

  return (
    <main
      className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3"
      style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}
    >
      <SectionRail items={CONFIGURATION_ITEMS} activeId={activeId} onSelect={navigate} ariaLabel="Configuration sections" />
      <section className="min-h-0 min-w-0 overflow-y-auto pr-1">{children}</section>
    </main>
  );
}
