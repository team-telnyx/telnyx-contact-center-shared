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
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

import Image from "next/image";
import menuConfig from "@/config/menu";
import { Skeleton } from "@/components/ui/skeleton";

const data = {
  user: { name: "Loading...", email: "", avatar: "" },
  navGroups: menuConfig.navGroups,
};

export function AppSidebar({ hideNav, ...props }) {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState("guest");
  const [loading, setLoading] = useState(true);

  const fetchUserData = React.useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await res.json();
      if (data?.isAuth && data?.user) {
        setUser(data.user);
        setRole(data.user.role || "user");
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
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <Image
              src="/telnyx_green_transparent.png"
              alt="Telnyx LLC"
              width={250}
              height={50}
              priority
              style={{ width: "auto", height: "auto" }}
              className="brightness-0 dark:brightness-100"
            />
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5"
            ></SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {!hideNav &&
          (loading ? (
            <div className="flex flex-col gap-2 p-2">
              {[...Array(4)].map((_, gi) => (
                <div key={gi} className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-40" />
                  <div className="pl-2.5 flex flex-col gap-2">
                    <Skeleton className="h-8 w-48" />
                    <Skeleton className="h-8 w-44" />
                    <Skeleton className="h-8 w-40" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <NavMain groups={data.navGroups} userRole={role} />
          ))}
      </SidebarContent>
      <SidebarFooter>
        {loading ? (
          <div className="flex items-center gap-3 px-3 py-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1">
              <Skeleton className="h-3 w-28 mb-2" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ) : (
          <NavUser user={user || data.user} hideExtras={hideNav} />
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
