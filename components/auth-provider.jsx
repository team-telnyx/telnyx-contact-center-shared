"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { usePathname, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { subscribeStatusStream } from "@/lib/status-stream-client";
import { matches, SCREEN_PREFIX, WILDCARD } from "@/lib/authz/permissions.mjs";
import { decidePageAccess } from "@/lib/authz/page-access.mjs";

const AuthContext = createContext({
  isAuth: false,
  loaded: false,
  user: null,
  permissions: [],
  screens: [],
  scopes: null,
  wildcard: false,
  can: () => false,
  canScreen: () => false,
  refresh: async () => {},
});

export function AuthProvider({ children }) {
  // `loaded` turns true after the first profile answer, so gates can tell
  // "not signed in" from "not known yet".
  const [state, setState] = useState({ isAuth: false, user: null, loaded: false });
  const { setTheme } = useTheme();
  const pathname = usePathname();
  const session = useSession();
  const updateSession = session?.update;

  const refresh = useCallback(async () => {
    try {
      let res = await fetch("/api/auth/me", {
        credentials: "include",
        cache: "no-store",
      });

      // If auth error, try refreshing token first
      if (res.status === 401 || res.status === 403) {
        try {
          const refreshRes = await fetch("/api/auth/refresh", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
          });
          if (refreshRes.ok) {
            // Retry after refresh
            res = await fetch("/api/auth/me", {
              credentials: "include",
              cache: "no-store",
            });
          }
        } catch (_) {
          // Refresh failed, user needs to re-authenticate
        }
      }

      const data = await res.json();
      setState({ isAuth: !!data.isAuth, user: data.user || null, loaded: true });
      if (data?.isAuth && data?.user?.theme) {
        const val = String(data.user.theme);
        if (["light", "dark", "system"].includes(val)) setTheme(val);
      }
    } catch (_) {
      setState({ isAuth: false, user: null, loaded: true });
    }
  }, [setTheme]);

  useEffect(() => {
    // Deferred so the profile fetch (and its setState) runs outside the effect body.
    const timer = setTimeout(() => {
      refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [pathname, refresh]);

  // A role or assignment change is pushed as `authz_changed` on the shared
  // status stream; reloading the profile refreshes permissions within seconds
  // and the NextAuth session update rewrites the screen snapshot the proxy
  // falls back to.
  useEffect(() => {
    if (!state.isAuth) return undefined;
    return subscribeStatusStream("authz_changed", () => {
      refresh();
      if (typeof updateSession === "function") updateSession().catch(() => {});
    });
  }, [state.isAuth, refresh, updateSession]);

  const value = useMemo(() => {
    const permissions = Array.isArray(state.user?.permissions) ? state.user.permissions : [];
    const screens = Array.isArray(state.user?.screens) ? state.user.screens : [];
    const wildcard = permissions.includes(WILDCARD);
    const can = (key) => {
      if (!state.isAuth) return false;
      if (wildcard) return true;
      const required = Array.isArray(key) ? key : [key];
      return required.some((k) => permissions.some((granted) => matches(granted, k)));
    };
    const canScreen = (id) => {
      if (!state.isAuth) return false;
      if (wildcard) return true;
      const target = String(id || "").replace(SCREEN_PREFIX, "");
      return screens.some((screen) => screen === target || screen.startsWith(`${target}.`));
    };
    return { ...state, permissions, screens, scopes: state.user?.scopes || null, wildcard, can, canScreen, refresh };
  }, [state, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

/** Render children only when the current user holds the permission (or any of a list). */
export function Can({ permission, screen, fallback = null, children }) {
  const { can, canScreen } = useAuth();
  const allowed = screen ? canScreen(screen) : can(permission);
  return allowed ? children : fallback;
}

/**
 * Client-side page gate (RBAC Phase 3). The proxy refuses direct navigation;
 * this covers client-side transitions and a stale token: once the profile is
 * known, a portal path whose screen the roles do not grant renders an access
 * notice instead of the page. Explicit `screen` overrides the path lookup.
 */
export function ScreenGuard({ screen = null, children }) {
  const { isAuth, loaded, screens, wildcard } = useAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (!loaded || !isAuth) return children;
  const grants = wildcard ? [WILDCARD] : screens;
  const decision = screen
    ? { allowed: wildcard || screens.some((s) => s === screen || s.startsWith(`${screen}.`)), label: screen, gated: true }
    : decidePageAccess({ pathname, search: searchParams.toString(), screens: grants });
  if (!decision.gated || decision.allowed) return children;
  return (
    <div className="flex flex-1 items-center justify-center p-6" data-testid="screen-guard-denied">
      <div className="max-w-md rounded-2xl border bg-card p-6 text-center shadow-sm">
        <h2 className="text-lg font-semibold">Access denied</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your roles do not include <span className="font-medium text-foreground">{decision.label || "this screen"}</span>. Ask an administrator to grant it in Permissions.
        </p>
      </div>
    </div>
  );
}
