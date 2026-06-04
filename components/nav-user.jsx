"use client";

import {
  IconDotsVertical,
  IconLogout,
  IconUserCircle,
  IconCheck,
} from "@tabler/icons-react";
import { USER_STATUS_OPTIONS, DEFAULT_USER_STATUS } from "@/config/user";

import { Moon, Sun, Monitor } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import useCallsStore from "@/lib/stores/calls-store";
import useActiveCallStore from "@/lib/stores/active-call-store";
// No Link: SPA-style selection via hash

// Helper function to get user initials
function getUserInitials(user) {
  if (!user) return "UN";
  if (user.firstName && user.lastName) {
    return `${user.firstName[0] || ""}${user.lastName[0] || ""}`.toUpperCase();
  }
  if (user.name) {
    const parts = user.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return `${parts[0][0] || ""}${
        parts[parts.length - 1][0] || ""
      }`.toUpperCase();
    }
    if (parts.length === 1 && parts[0].length > 0) {
      return parts[0][0].toUpperCase();
    }
  }
  if (user.email) {
    return user.email[0].toUpperCase();
  }
  return "UN";
}

export function NavUser({ user, hideExtras }) {
  const { isMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const logoutInFlightRef =
    typeof window !== "undefined"
      ? (window.__logoutInFlightRef ||= { v: false })
      : { v: false };

  const userInitials = getUserInitials(user);

  // Get the profile picture source, handling data URLs and regular URLs
  const getProfilePictureSrc = () => {
    if (!user) return "/avatar.jpeg";
    const src =
      user.profilePictureUri || user.image || user.profile_picture_uri;
    if (!src) return "/avatar.jpeg";
    // If it's a data URL, return it as-is
    if (typeof src === "string" && src.startsWith("data:")) {
      return src;
    }
    // If it's a relative path, ensure it starts with /
    if (
      typeof src === "string" &&
      !src.startsWith("http") &&
      !src.startsWith("/")
    ) {
      return `/${src}`;
    }
    return src || "/avatar.jpeg";
  };

  const profilePictureSrc = getProfilePictureSrc();

  async function updateThemeOnServer(nextTheme) {
    try {
      await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: nextTheme }),
      });
    } catch (_) {}
  }

  const [status, setStatus] = useState(DEFAULT_USER_STATUS);

  // Subscribe to SSE stream for real-time status updates
  useEffect(() => {
    let eventSource = null;
    let reconnectTimeout = null;

    const connectStatusStream = () => {
      try {
        // Close existing connection if any
        if (eventSource) {
          eventSource.close();
        }

        eventSource = new EventSource("/api/user/status-stream");

        eventSource.addEventListener("status_changed", (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.status && data.status !== status) {
              console.log(
                "[Status] Received status update via SSE:",
                data.status
              );
              setStatus(data.status);
            }
          } catch (error) {
            console.error("[Status] Error parsing SSE data:", error);
          }
        });

        eventSource.addEventListener("connected", () => {
          console.log("[Status] Connected to status stream");
        });

        eventSource.addEventListener("ping", () => {
          // Keep-alive ping received
        });

        eventSource.onerror = (error) => {
          console.warn("[Status] SSE connection error:", error);
          // Close and reconnect after delay
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          // Reconnect after 5 seconds
          reconnectTimeout = setTimeout(() => {
            connectStatusStream();
          }, 5000);
        };
      } catch (error) {
        console.error("[Status] Failed to connect to status stream:", error);
        // Retry after delay
        reconnectTimeout = setTimeout(() => {
          connectStatusStream();
        }, 5000);
      }
    };

    // Connect to status stream for authenticated users
    connectStatusStream();

    return () => {
      if (eventSource) {
        eventSource.close();
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
    };
  }, []);

  async function updateStatusOnServer(nextStatus) {
    // Persist status to database
    try {
      await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
    } catch (_) {}
  }

  async function handleLogout() {
    if (logoutInFlightRef.v) return;
    logoutInFlightRef.v = true;

    // Mark that we're logging out to prevent automatic offline status
    if (typeof window !== "undefined" && window.__markLoggingOut) {
      window.__markLoggingOut();
    }

    try {
      try {
        updateStatusOnServer("Offline");
      } catch (_) {}

      try {
        useCallsStore.getState().clearAllCalls();
        useActiveCallStore.getState().clearActiveCall();
        localStorage.removeItem("calls-store");
        localStorage.removeItem("active-call-store");
      } catch (_) {}

      // Clear local storage
      try {
        localStorage.removeItem("nav-main.selected");
        localStorage.removeItem("webrtc.token.cache");
      } catch (_) {}

      // Try to call logout API to clear server-side session and refresh tokens
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
        });
      } catch (_) {
        // Ignore errors - we'll clear cookies client-side anyway
      }

      // Try NextAuth signOut (may fail if session already expired, that's ok)
      try {
        await signOut({ redirect: false });
      } catch (_) {
        // Session might already be expired, continue with logout anyway
      }
    } finally {
      // Always redirect to signin, even if some logout steps failed
      logoutInFlightRef.v = false;
      window.location.href = "/signin";
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarImage
                  src={profilePictureSrc}
                  alt={user?.name || "User"}
                  className="object-cover"
                />
                <AvatarFallback className="rounded-lg">
                  {userInitials}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {user?.name || "User"}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {user?.email || ""}
                </span>
              </div>
              <IconDotsVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            {/* Status selector for authenticated users */}
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarImage
                    src={profilePictureSrc}
                    alt={user?.name || "User"}
                    className="object-cover"
                  />
                  <AvatarFallback className="rounded-lg">
                    {userInitials}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {user.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            {!hideExtras && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs uppercase text-muted-foreground">
                Theme
              </DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => {
                  updateThemeOnServer("light");
                  setTheme("light");
                }}
              >
                <Sun />
                Light
                {theme === "light" ? (
                  <IconCheck className="ml-auto text-[#00C389]" />
                ) : null}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  updateThemeOnServer("dark");
                  setTheme("dark");
                }}
              >
                <Moon />
                Dark
                {theme === "dark" ? (
                  <IconCheck className="ml-auto text-[#00C389]" />
                ) : null}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  updateThemeOnServer("system");
                  setTheme("system");
                }}
              >
                <Monitor />
                System
                {theme === "system" ? (
                  <IconCheck className="ml-auto text-[#00C389]" />
                ) : null}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {!hideExtras && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    try {
                      const ev = new CustomEvent("nav-main:selected", {
                        detail: "USER SETTINGS::Profile",
                      });
                      window.dispatchEvent(ev);
                      router.push("/profile");
                    } catch (_) {}
                  }}
                >
                  <IconUserCircle />
                  User Profile
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              <IconLogout />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
