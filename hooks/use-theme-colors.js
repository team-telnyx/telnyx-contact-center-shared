"use client";

import { useEffect } from "react";
import { getDefaultColors } from "@/lib/color-utils";

/**
 * Hook to load and apply theme colors from localStorage on app start
 */
export function useThemeColors() {
  useEffect(() => {
    const loadColors = () => {
      try {
        const saved = localStorage.getItem("theme-colors");
        if (saved) {
          const parsed = JSON.parse(saved);
          const root = document.documentElement;

          if (parsed.light && parsed.dark) {
            // New format with separate light/dark colors
            const isDark = root.classList.contains("dark");
            const colorsToApply = isDark ? parsed.dark : parsed.light;

            Object.entries(colorsToApply).forEach(([key, value]) => {
              root.style.setProperty(`--${key}`, value);
            });
          } else {
            // Legacy format - apply to both themes
            Object.entries(parsed).forEach(([key, value]) => {
              root.style.setProperty(`--${key}`, value);
            });
          }
        }
      } catch (e) {
        console.error("Error loading theme colors:", e);
      }
    };

    loadColors();

    // Watch for theme changes
    const observer = new MutationObserver(() => {
      const saved = localStorage.getItem("theme-colors");
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          const root = document.documentElement;

          if (parsed.light && parsed.dark) {
            const isDark = root.classList.contains("dark");
            const colorsToApply = isDark ? parsed.dark : parsed.light;

            Object.entries(colorsToApply).forEach(([key, value]) => {
              root.style.setProperty(`--${key}`, value);
            });
          }
        } catch (e) {
          // Ignore errors
        }
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);
}
