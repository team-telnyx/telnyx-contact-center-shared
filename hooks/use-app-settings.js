"use client";

import { useState, useEffect } from "react";

/**
 * Hook to fetch app settings (logos, theme colors)
 */
export function useAppSettings() {
  const [settings, setSettings] = useState({
    brandLogoUri: null,
    authRightImageUri: null,
    sidebarLogoUri: null,
    themeColors: { light: {}, dark: {} },
    loading: true,
  });

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await fetch("/api/app-settings");
        if (response.ok) {
          const data = await response.json();
          setSettings({
            brandLogoUri: data.brandLogoUri,
            authRightImageUri: data.authRightImageUri,
            sidebarLogoUri: data.sidebarLogoUri,
            themeColors: data.themeColors || { light: {}, dark: {} },
            loading: false,
          });
        } else {
          setSettings((prev) => ({ ...prev, loading: false }));
        }
      } catch (error) {
        console.error("Error fetching app settings:", error);
        setSettings((prev) => ({ ...prev, loading: false }));
      }
    };

    fetchSettings();
  }, []);

  return settings;
}
