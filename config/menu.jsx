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
  IconHistory,
  IconFileMusic,
  IconAward,
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
          title: "Monitor",
          url: "/supervisor/monitor",
          icon: IconActivity,
          role_access: ["supervisor", "admin", "owner"],
        },
        {
          title: "Call History",
          url: "/supervisor/call-history",
          icon: IconHistory,
          role_access: ["supervisor", "admin", "owner"],
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
          title: "Contacts",
          url: "/admin/contacts",
          icon: IconAddressBook,
          role_access: ["admin", "owner"],
        },
        {
          title: "Numbers",
          url: "/admin/numbers",
          icon: IconPhone,
          role_access: ["admin", "owner"],
        },
        {
          title: "Queues",
          url: "/admin/queues",
          icon: IconList,
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
          title: "Skills",
          url: "/admin/skills",
          icon: IconAward,
          role_access: ["admin", "owner"],
        },
        {
          title: "Media Library",
          url: "/admin/media-library",
          icon: IconFileMusic,
          role_access: ["admin", "owner"],
        },
        {
          title: "Call Flows",
          url: "/admin/call-flows",
          icon: IconGitBranch,
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
      ],
    },
  ],
};

export default menuConfig;
