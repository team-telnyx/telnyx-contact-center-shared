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
  IconWorld,
  IconMail,
  IconMessage,
  IconBrandWhatsapp,
} from "@tabler/icons-react";

// Menu configuration for Contact Center.
//
// Visibility follows the permission catalogue (lib/authz/permissions.mjs):
// every item names the screen (or screen group) it opens and is shown when
// the user's roles grant that screen or any leaf below it; a group is shown
// when at least one of its items is. The former per-item role lists are gone
// (RBAC Phase 3, the internal documentation).
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
          screen: "agent.desktop",
        },
      ],
    },
    {
      label: "SUPERVISOR",
      icon: null,
      items: [
        {
          title: "Monitoring",
          description: "Watch live agent and queue activity",
          url: "/supervisor/monitor",
          icon: IconActivity,
          screen: "supervisor.monitor",
        },
        {
          title: "Analytics",
          description: "Explore performance and operational trends",
          url: "/supervisor/analytics",
          icon: IconChartBar,
          screen: "supervisor.analytics",
        },
        {
          title: "Quality",
          description: "Review conversations and coaching results",
          url: "/supervisor/quality",
          icon: IconClipboardCheck,
          screen: "supervisor.quality",
        },
        {
          title: "Outbound Dialer",
          description: "Run and monitor outbound campaigns",
          url: "/supervisor/outbound-dialer",
          icon: IconSpeakerphone,
          // Decision D-13 (2026-09-15): the system admin role includes the dialer.
          screen: "supervisor.outbound-dialer",
        },
      ],
    },
    {
      label: "ADMIN",
      icon: null,
      items: [
        {
          title: "Configuration",
          description: "Manage users, routing, and shared resources",
          url: "/admin/users",
          activeUrls: [
            "/admin/teams", "/admin/queues", "/admin/skills", "/admin/statuses", "/admin/wrapup-codes",
            "/admin/numbers", "/admin/data-sources", "/admin/web-pages", "/admin/media-library",
            "/admin/domains", "/admin/secrets", "/admin/permissions",
          ],
          icon: IconSettings,
          screen: "admin.configuration",
        },
        {
          title: "Automations",
          description: "Design flows, workflows, and forms",
          url: "/admin/call-flows",
          activeUrls: ["/admin/workflows", "/admin/forms"],
          icon: IconGitBranch,
          screen: "admin.automations",
        },
        {
          title: "AI Assistants",
          description: "Build and manage AI-powered assistants",
          url: "/admin/ai-assistants",
          activeUrls: ["/admin/tools-library", "/admin/insights", "/supervisor/scheduled-events", "/admin/mcp-servers"],
          icon: IconRobot,
          screens: ["admin.ai", "supervisor.scheduled-events"],
        },
        {
          title: "Email",
          description: "Manage mailboxes, domains and email delivery",
          url: "/admin/email",
          icon: IconMail,
          screen: "admin.email",
        },
        {
          title: "SMS",
          description: "Map SMS numbers to queues and manage delivery",
          url: "/admin/sms",
          icon: IconMessage,
          screen: "admin.sms",
        },
        {
          title: "WhatsApp",
          description: "Connect the WhatsApp Business Account, templates and numbers",
          url: "/admin/whatsapp",
          icon: IconBrandWhatsapp,
          screen: "admin.whatsapp",
        },
        {
          title: "Web Widgets",
          description: "Configure website messaging and voice widgets",
          url: "/admin/widgets",
          icon: IconWorld,
          screen: "admin.widgets",
        },
        {
          title: "System",
          description: "Control platform operations and appearance",
          url: "/admin/system/dashboard",
          activeUrls: ["/admin/call-generator", "/admin/logging", "/admin/phones-provisioning", "/settings"],
          icon: IconSettings,
          screen: "admin.system",
        },
      ],
    },
  ],
};

/** Screens an item (or group) needs: any of them grants visibility. */
export function menuItemScreens(item) {
  if (!item) return [];
  if (Array.isArray(item.screens)) return item.screens;
  return item.screen ? [item.screen] : [];
}

export default menuConfig;
