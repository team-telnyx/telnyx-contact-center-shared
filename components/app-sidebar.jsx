"use client";

import * as React from "react";

import dynamic from "next/dynamic";
const NavMain = dynamic(
  () => import("@/components/nav-main").then((m) => m.NavMain),
  { ssr: false }
);
const NavUser = dynamic(
  () => import("@/components/nav-user").then((m) => m.NavUser),
  { ssr: false }
);
import { useEffect, useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

import menuConfig from "@/config/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarLogo } from "@/components/sidebar-logo";
import { cn } from "@/lib/utils";

const data = {
  user: { name: "Loading...", email: "", avatar: "" },
  navGroups: menuConfig.navGroups,
};

export function AppSidebar({ hideNav, className, ...props }) {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState("agent");
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchUserData = React.useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await res.json();
      if (data?.isAuth && data?.user) {
        setUser(data.user);
        // Support both roles array and legacy role field
        const userRoles =
          data.user.roles &&
          Array.isArray(data.user.roles) &&
          data.user.roles.length > 0
            ? data.user.roles
            : ["agent"];
        setRoles(userRoles);
      }
    } catch (_) {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUserData();
  }, [fetchUserData]);

  // Listen for profile updates
  useEffect(() => {
    const handleProfileUpdate = () => {
      fetchUserData();
    };

    if (typeof window !== "undefined") {
      window.addEventListener("profile:updated", handleProfileUpdate);
      return () => {
        window.removeEventListener("profile:updated", handleProfileUpdate);
      };
    }
  }, [fetchUserData]);

  return (
    <Sidebar
      collapsible="offcanvas"
      className={cn(
        "[&_[data-slot=sidebar-inner]]:bg-transparent",
        className,
      )}
      {...props}
    >
      <div className="flex h-full min-h-0 flex-col bg-sidebar">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-background shadow-sm">
          <SidebarHeader className="shrink-0 border-b bg-background p-4">
            <SidebarMenu>
              <SidebarMenuItem>
                <div className="flex h-14 w-full items-center justify-center overflow-hidden p-1">
                  <SidebarLogo className="max-h-full max-w-full" />
                </div>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>

          <SidebarContent className="scrollbar-none p-3">
            {!hideNav &&
              (loading ? (
                <div className="flex flex-col gap-3">
                  {[...Array(3)].map((_, index) => (
                    <Skeleton key={index} className="h-32 w-full rounded-2xl" />
                  ))}
                </div>
              ) : (
                <NavMain
                  groups={data.navGroups}
                  userRole={role}
                  userRoles={roles}
                />
              ))}
          </SidebarContent>

          <SidebarFooter className="shrink-0 border-t bg-background p-3">
            {loading ? (
              <div className="flex min-h-20 items-center gap-3 px-3 py-3">
                <Skeleton className="h-11 w-11 rounded-xl" />
                <div className="flex-1">
                  <Skeleton className="mb-2 h-3 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ) : (
              <NavUser user={user || data.user} hideExtras={hideNav} />
            )}
          </SidebarFooter>
        </div>
      </div>
    </Sidebar>
  );
}
