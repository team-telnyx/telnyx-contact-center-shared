"use client";

import {
  IconDeviceDesktop,
  IconSettings,
  IconPalette,
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
      label: "ADMIN",
      icon: null,
      role_access: ["admin", "owner"], // Only show this group to admin/owner roles
      items: [
        {
          title: "Settings",
          url: "/settings",
          icon: IconPalette,
          role_access: ["admin", "owner"],
        },
      ],
    },
  ],
};

export default menuConfig;
