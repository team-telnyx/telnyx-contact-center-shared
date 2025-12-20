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
          role_access: ["user", "admin", "owner"], // All authenticated users can access agent features
        },
        {
          title: "Configuration",
          url: "/agent/configuration",
          icon: IconSettings,
          role_access: ["user", "admin", "owner"], // All authenticated users can access agent features
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
