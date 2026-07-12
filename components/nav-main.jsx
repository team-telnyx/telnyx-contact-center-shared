"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  IconActivity,
  IconArrowLeft,
  IconChevronRight,
  IconHeadset,
  IconShieldCog,
} from "@tabler/icons-react";

const WORKSPACE_META = {
  AGENT: {
    name: "Agent",
    title: "Agent Workspace",
    description: "Handle customer conversations",
    stages: ["Connect", "Assist", "Resolve"],
    Icon: IconHeadset,
    accent: "text-emerald-500 dark:text-emerald-300",
    iconBackground: "bg-emerald-500/12",
    hoverBorder: "hover:border-emerald-500/55",
  },
  SUPERVISOR: {
    name: "Supervisor",
    title: "Supervisor Workspace",
    description: "Monitor teams and performance",
    stages: ["Observe", "Coach", "Improve"],
    Icon: IconActivity,
    accent: "text-violet-500 dark:text-violet-300",
    iconBackground: "bg-violet-500/12",
    hoverBorder: "hover:border-violet-500/55",
  },
  ADMIN: {
    name: "Admin",
    title: "Admin Workspace",
    description: "Configure your contact center",
    stages: ["Configure", "Control", "Scale"],
    Icon: IconShieldCog,
    accent: "text-blue-500 dark:text-blue-300",
    iconBackground: "bg-blue-500/12",
    hoverBorder: "hover:border-blue-500/55",
  },
};

export function NavMain({ groups = [], userRole = "guest", userRoles = [] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedWorkspace, setSelectedWorkspace] = useState(() => {
    if (pathname.startsWith("/agent")) return "AGENT";
    if (pathname.startsWith("/supervisor")) return "SUPERVISOR";
    if (pathname.startsWith("/admin") || pathname.startsWith("/settings")) {
      return "ADMIN";
    }
    return null;
  });

  const normalizedRoles =
    Array.isArray(userRoles) && userRoles.length > 0
      ? userRoles.map((role) => String(role).toLowerCase())
      : userRole
        ? [String(userRole).toLowerCase()]
        : ["guest"];

  const hasRole = (requiredRoles) => {
    const roles = Array.isArray(requiredRoles)
      ? requiredRoles
      : [requiredRoles];
    return roles.some((role) =>
      normalizedRoles.includes(String(role).toLowerCase()),
    );
  };

  const visibleGroups = groups
    .filter((group) => !group.role_access || hasRole(group.role_access))
    .map((group) => ({
      ...group,
      items:
        group.items?.filter(
          (item) => !item.role_access || hasRole(item.role_access),
        ) || [],
    }))
    .filter((group) => group.items.length > 0);

  const isActiveUrl = (url) =>
    Boolean(url && (pathname === url || pathname.startsWith(`${url}/`)));

  const matchesQueryRule = (rule) =>
    isActiveUrl(rule.url) && searchParams.get(rule.param) === rule.value;

  const isItemActive = (item) => {
    const isSuppressed = item.inactiveUrlQueries?.some(matchesQueryRule);
    return (
      !isSuppressed &&
      (isActiveUrl(item.url) ||
        item.activeUrls?.some(isActiveUrl) ||
        item.activeUrlQueries?.some(matchesQueryRule))
    );
  };

  const activeWorkspace = visibleGroups.find(
    (group) => group.label === selectedWorkspace,
  );

  if (!activeWorkspace) {
    return (
      <nav aria-label="Workspaces" className="flex flex-col gap-3">
        {visibleGroups.map((group) => {
          const meta = WORKSPACE_META[group.label] || {
            name: group.label,
            title: `${group.label} Workspace`,
            description: "Open workspace",
            stages: ["Open", "Manage", "Complete"],
            Icon: group.items[0]?.icon || IconActivity,
            accent: "text-brand-primary",
            iconBackground: "bg-brand-primary/12",
            hoverBorder: "hover:border-brand-primary/55",
          };
          const { Icon } = meta;

          return (
            <button
              key={group.label}
              type="button"
              onClick={() => setSelectedWorkspace(group.label)}
              className={`group flex aspect-square w-full shrink-0 flex-col justify-between rounded-2xl border bg-card/70 p-5 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:bg-card hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring ${meta.hoverBorder}`}
            >
              <span className="flex w-full items-center gap-4">
                <span
                  className={`flex size-14 shrink-0 items-center justify-center rounded-2xl ${meta.iconBackground} ${meta.accent}`}
                >
                  <Icon className="size-8" stroke={1.7} />
                </span>
                <span className="min-w-0">
                  <span className="block text-lg font-semibold leading-tight">
                    {meta.name}
                  </span>
                  <span className="block text-sm font-medium leading-tight text-muted-foreground">
                    Workspace
                  </span>
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`relative flex w-full items-start justify-between ${meta.accent}`}
              >
                <span className="absolute top-4 right-4 left-4 h-px bg-current opacity-25 transition-opacity group-hover:opacity-50" />
                {meta.stages.map((stage, index) => (
                  <span
                    key={stage}
                    className="relative flex min-w-0 flex-1 flex-col items-center gap-2"
                  >
                    <span
                      className={`relative z-10 flex size-8 items-center justify-center rounded-full border border-current/35 bg-background transition-transform group-hover:scale-105 ${
                        index === 1 ? "ring-4 ring-current/10" : ""
                      }`}
                    >
                      <span
                        className={`rounded-full bg-current ${
                          index === 1 ? "size-2.5" : "size-1.5 opacity-70"
                        }`}
                      />
                    </span>
                    <span className="max-w-full truncate text-[10px] font-medium tracking-wide text-muted-foreground">
                      {stage}
                    </span>
                  </span>
                ))}
              </span>
              <span className="flex w-full items-center gap-3">
                <span className="min-w-0 flex-1 text-sm leading-snug text-muted-foreground">
                  {meta.description}
                </span>
                <span
                  className={`flex size-9 shrink-0 items-center justify-center rounded-full border bg-background transition-transform group-hover:translate-x-0.5 ${meta.accent}`}
                >
                  <IconChevronRight className="size-5" />
                </span>
              </span>
            </button>
          );
        })}
      </nav>
    );
  }

  const workspaceMeta = WORKSPACE_META[activeWorkspace.label] || {
    title: `${activeWorkspace.label} Workspace`,
    accent: "text-brand-primary",
    iconBackground: "bg-brand-primary/12",
    hoverBorder: "hover:border-brand-primary/55",
  };

  return (
    <nav
      aria-label={`${workspaceMeta.title} navigation`}
      className="flex min-h-full flex-col"
    >
      <div className="flex flex-col gap-3">
        {activeWorkspace.items.map((item) => {
          const ItemIcon = item.icon;
          const active = isItemActive(item);

          return (
            <Link
              key={`${activeWorkspace.label}::${item.title}`}
              href={item.url || "#"}
              aria-current={active ? "page" : undefined}
              className={`group flex h-28 w-full items-center gap-3 rounded-2xl border p-4 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring ${
                active
                  ? "border-brand-primary bg-brand-primary/10"
                  : `bg-card/70 hover:bg-card ${workspaceMeta.hoverBorder}`
              }`}
            >
              <span
                className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${workspaceMeta.iconBackground} ${workspaceMeta.accent}`}
              >
                {ItemIcon ? <ItemIcon className="size-6" stroke={1.7} /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold leading-tight">
                  {item.title}
                </span>
                <span className="mt-1 block text-xs leading-snug text-muted-foreground">
                  {item.description || "Open module"}
                </span>
              </span>
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-full border bg-background transition-transform group-hover:translate-x-0.5 ${workspaceMeta.accent}`}
              >
                <IconChevronRight className="size-4" />
              </span>
            </Link>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setSelectedWorkspace(null)}
        className="mt-3 flex min-h-14 w-full items-center gap-3 rounded-2xl border bg-card/70 px-4 text-left text-sm font-semibold shadow-xs transition-all hover:border-brand-primary/55 hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-9 items-center justify-center rounded-xl bg-muted text-foreground">
          <IconArrowLeft className="size-5" />
        </span>
        <span>Back</span>
      </button>
    </nav>
  );
}
