"use client";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { Fragment, useEffect, useState } from "react";
import { IconHome, IconChevronDown } from "@tabler/icons-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavMain({ groups = [], userRole = "guest", userRoles = [] }) {
  const pathname = usePathname();
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());

  // Normalize userRoles - support both single role and roles array
  const normalizedRoles =
    Array.isArray(userRoles) && userRoles.length > 0
      ? userRoles.map((r) => String(r).toLowerCase())
      : userRole
      ? [String(userRole).toLowerCase()]
      : ["guest"];

  const hasRole = (requiredRoles) => {
    if (!Array.isArray(requiredRoles)) requiredRoles = [requiredRoles];
    return requiredRoles.some((role) =>
      normalizedRoles.includes(String(role).toLowerCase())
    );
  };

  const isActiveUrl = (url) => {
    try {
      if (!url) return false;
      return pathname === url || pathname.startsWith(`${url}/`);
    } catch (_) {
      return false;
    }
  };

  // Start collapsed by default. Do not auto-expand groups on first render.
  useEffect(() => {
    setExpandedGroups((prev) => (prev instanceof Set ? prev : new Set()));
  }, [groups]);

  return (
    <div className="flex flex-col gap-0">
      {/* Home (route navigation) */}
      <SidebarGroup>
        <SidebarGroupContent className="flex flex-col gap-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip="Home Page"
                isActive={pathname === "/"}
                className="rounded-md data-[active=true]:bg-brand-primary data-[active=true]:text-black"
              >
                <Link href="/">
                  <span>
                    <IconHome />
                  </span>
                  <span>Home Page</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarSeparator className="my-1" />
      {(() => {
        // Filter groups and items based on user role
        const visibleGroups = groups
          .filter((group) => {
            // First check if the group itself has role_access restrictions
            if (group.role_access) {
              if (!hasRole(group.role_access)) {
                return false; // Hide entire group if user doesn't have any required role
              }
            }
            return true; // Show group if no role_access or user has required role
          })
          .map((group) => {
            // Filter items within each group based on role access
            const visibleItems =
              group.items?.filter((item) => {
                if (!item.role_access) return true; // If no role_access specified, show to all
                return hasRole(item.role_access);
              }) || [];

            // Return group with filtered items
            return {
              ...group,
              items: visibleItems,
            };
          })
          .filter((group) => {
            // Only show groups that have visible items
            return group.items && group.items.length > 0;
          });
        return visibleGroups.map((group, idx) => {
          const isOpen = expandedGroups.has(group.label);
          const toggle = () =>
            setExpandedGroups((prev) => {
              const currentlyOpen = prev.has(group.label);
              if (currentlyOpen) {
                return new Set();
              }
              return new Set([group.label]);
            });
          return (
            <Fragment key={group.label}>
              <SidebarGroup>
                <SidebarGroupLabel
                  className="font-medium text-muted-foreground text-sm cursor-pointer pr-6 inline-flex items-center gap-2"
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                  role="button"
                  aria-expanded={isOpen}
                  tabIndex={0}
                >
                  {/* {group.icon && (
                    <group.icon className="size-6 text-orange-500" />
                  )} */}
                  <span>{group.label}</span>
                </SidebarGroupLabel>
                <SidebarGroupAction
                  onClick={toggle}
                  aria-label="Toggle section"
                >
                  <IconChevronDown
                    className={
                      isOpen
                        ? "transition-transform"
                        : "-rotate-90 transition-transform"
                    }
                  />
                </SidebarGroupAction>
                <SidebarGroupContent
                  className="flex flex-col gap-2 pl-2.5"
                  style={{ display: isOpen ? undefined : "none" }}
                >
                  <SidebarMenu>
                    {group.items?.map((item) => {
                      const key = `${group.label}::${item.title}`;
                      const url = item.url || "#";
                      return (
                        <SidebarMenuItem key={key}>
                          <SidebarMenuButton
                            asChild
                            tooltip={item.title}
                            isActive={isActiveUrl(url)}
                            className="rounded-md data-[active=true]:bg-brand-primary data-[active=true]:text-black"
                          >
                            <Link href={url}>
                              {item.icon && <item.icon />}
                              <span>{item.title}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
              {idx < visibleGroups.length - 1 && (
                <SidebarSeparator className="my-1" />
              )}
            </Fragment>
          );
        });
      })()}
    </div>
  );
}
