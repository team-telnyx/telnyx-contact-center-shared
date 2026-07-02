"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";

const AuthContext = createContext({
  isAuth: false,
  user: null,
  refresh: async () => {},
});

export function AuthProvider({ children }) {
  const [state, setState] = useState({ isAuth: false, user: null });
  const { setTheme } = useTheme();
  const pathname = usePathname();

  async function refresh() {
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
      setState({ isAuth: !!data.isAuth, user: data.user || null });
      if (data?.isAuth && data?.user?.theme) {
        const val = String(data.user.theme);
        if (["light", "dark", "system"].includes(val)) setTheme(val);
      }
    } catch (_) {
      setState({ isAuth: false, user: null });
    }
  }

  useEffect(() => {
      refresh();
  }, [pathname]);

  return (
    <AuthContext.Provider value={{ ...state, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
