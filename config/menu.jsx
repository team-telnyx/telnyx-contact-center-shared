"use client";

import {
  IconDeviceDesktop,
  IconSettings,
  IconActivity,
  IconChartBar,
  IconClipboardCheck,
  IconGitBranch,
  IconSpeakerphone,
  IconRobot,
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
          description: "Handle calls and customer conversations",
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
          description: "Watch live agent and queue activity",
          url: "/supervisor/monitor",
          icon: IconActivity,
          role_access: ["supervisor", "admin", "owner"],
        },
        {
          title: "Analytics",
          description: "Explore performance and operational trends",
          url: "/supervisor/analytics",
          icon: IconChartBar,
          role_access: ["supervisor", "admin", "owner"],
        },
        {
          title: "Quality",
          description: "Review conversations and coaching results",
          url: "/supervisor/quality",
          icon: IconClipboardCheck,
          role_access: ["supervisor", "admin", "owner"],
        },
        {
          title: "Outbound Dialer",
          description: "Run and monitor outbound campaigns",
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
          title: "Configuration",
          description: "Manage users, routing, and shared resources",
          url: "/admin/users",
          activeUrls: [
            "/admin/queues", "/admin/skills", "/admin/statuses", "/admin/wrapup-codes",
            "/admin/numbers", "/admin/data-sources", "/admin/web-pages", "/admin/media-library",
            "/admin/domains", "/admin/secrets",
          ],
          icon: IconSettings,
          role_access: ["admin", "owner"],
        },
        {
          title: "Automations",
          description: "Design flows, workflows, and forms",
          url: "/admin/call-flows",
          activeUrls: ["/admin/workflows", "/admin/forms"],
          icon: IconGitBranch,
          role_access: ["admin", "owner"],
        },
        {
          title: "AI Assistants",
          description: "Build and manage AI-powered assistants",
          url: "/admin/ai-assistants",
          activeUrls: ["/admin/tools-library", "/admin/insights", "/supervisor/scheduled-events", "/admin/mcp-servers"],
          icon: IconRobot,
          role_access: ["admin", "owner"],
        },
        {
          title: "System",
          description: "Control platform operations and appearance",
          url: "/admin/system/dashboard",
          activeUrls: ["/admin/call-generator", "/admin/logging", "/admin/phones-provisioning", "/settings"],
          icon: IconSettings,
          role_access: ["admin", "owner"],
        },
      ],
    },
  ],
};

export default menuConfig;
