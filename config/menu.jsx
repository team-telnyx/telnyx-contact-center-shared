"use client";

import {
  IconDeviceDesktop,
  IconSettings,
  IconPalette,
  IconUsers,
  IconList,
  IconActivity,
  IconTag,
  IconGitBranch,
  IconKey,
  IconAddressBook,
  IconPhone,

  IconFileMusic,
  IconAward,
  IconBook,
  IconCalendar,
  IconDatabase,
  IconWorld,
  IconPhoneCall,
  IconForms,
  IconSpeakerphone,
  IconTools,
  IconBug,
} from "@tabler/icons-react";

// Menu configuration for Contact Center
export const menuConfig = {
  navGroups: [
    {
      label: "AGENT",
      icon: null,
      items: [
        {
          title: "Desktop",
          url: "/agent/desktop",
          icon: IconDeviceDesktop,
          role_access: ["agent", "supervisor", "admin", "owner"], // All authenticated users can access agent features
        },
      ],
    },
    {
      label: "SUPERVISOR",
      icon: null,
      role_access: ["supervisor", "admin", "owner"], // Show this group to supervisor, admin, and owner roles
      items: [
        {
          title: "Monitoring",
          url: "/supervisor/monitor",
          icon: IconActivity,
          role_access: ["supervisor", "admin", "owner"],
        },
        {
          title: "Scheduled Events",
          url: "/supervisor/scheduled-events",
          icon: IconCalendar,
          role_access: ["supervisor", "admin", "owner"],
        },
        {
          title: "Outbound Dialer",
          url: "/supervisor/outbound-dialer",
          icon: IconSpeakerphone,
          role_access: ["owner"],
        },
      ],
    },
    {
      label: "ADMIN",
      icon: null,
      role_access: ["admin", "owner"], // Only show this group to admin/owner roles
      items: [
        {
          title: "Users",
          url: "/admin/users",
          icon: IconUsers,
          role_access: ["admin", "owner"],
        },
        {
          title: "Queues",
          url: "/admin/queues",
          icon: IconList,
          role_access: ["admin", "owner"],
        },
        {
          title: "Skills",
          url: "/admin/skills",
          icon: IconAward,
          role_access: ["admin", "owner"],
        },
        {
          title: "Statuses",
          url: "/admin/statuses",
          icon: IconTag,
          role_access: ["admin", "owner"],
        },
        {
          title: "Wrapup Codes",
          url: "/admin/wrapup-codes",
          icon: IconTag,
          role_access: ["admin", "owner"],
        },
        {
          title: "Workflows",
          url: "/admin/workflows",
          icon: IconGitBranch,
          role_access: ["admin", "owner"],
        },
        {
          title: "Forms",
          url: "/admin/forms",
          icon: IconForms,
          role_access: ["admin", "owner"],
        },
        {
          title: "Call Flows",
          url: "/admin/call-flows",
          icon: IconGitBranch,
          role_access: ["admin", "owner"],
        },
        {
          title: "Numbers",
          url: "/admin/numbers",
          icon: IconPhone,
          role_access: ["admin", "owner"],
        },
        {
          title: "Data Sources",
          url: "/admin/data-sources",
          icon: IconDatabase,
          role_access: ["admin", "owner"],
        },
        {
          title: "Web Pages",
          url: "/admin/web-pages",
          icon: IconWorld,
          role_access: ["admin", "owner"],
        },
        {
          title: "Media Library",
          url: "/admin/media-library",
          icon: IconFileMusic,
          role_access: ["admin", "owner"],
        },
        {
          title: "Domains",
          url: "/admin/domains",
          icon: IconWorld,
          role_access: ["admin", "owner"],
        },
        {
          title: "MCP Servers",
          url: "/admin/mcp-servers",
          icon: IconTools,
          role_access: ["admin", "owner"],
        },
        {
          title: "Logging",
          url: "/admin/logging",
          icon: IconBug,
          role_access: ["admin", "owner"],
        },
        {
          title: "Secrets",
          url: "/admin/secrets",
          icon: IconKey,
          role_access: ["admin", "owner"],
        },
        {
          title: "Theme Settings",
          url: "/settings",
          icon: IconPalette,
          role_access: ["admin", "owner"],
        },
        {
          title: "CTI Testing",
          url: "/admin/cti-testing",
          icon: IconPhoneCall,
          role_access: ["admin", "owner"],
        },
      ],
    },
  ],
};

export default menuConfig;
