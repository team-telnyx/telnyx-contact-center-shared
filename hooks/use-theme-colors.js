"use client";

import { useEffect } from "react";

/**
 * Hook to load and apply theme colors from localStorage on app start
 * and watch for theme changes to re-apply the correct colors
 */
export function useThemeColors() {
  useEffect(() => {
    // List of all color variables that can be customized
    const allColorVars = [
      "background",
      "foreground",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
      "modal",
      "modal-foreground",
      "modal-border",
      "sheet",
      "sheet-foreground",
      "sheet-border",
      "primary",
      "primary-foreground",
      "secondary",
      "secondary-foreground",
      "muted",
      "muted-foreground",
      "accent",
      "accent-foreground",
      "destructive",
      "border",
      "input",
      "ring",
      "chart-1",
      "chart-2",
      "chart-3",
      "chart-4",
      "chart-5",
      "sidebar",
      "sidebar-foreground",
      "sidebar-primary",
      "sidebar-primary-foreground",
      "sidebar-accent",
      "sidebar-accent-foreground",
      "sidebar-border",
      "sidebar-ring",
      "brand-primary",
      "brand-secondary",
      "brand-background",
    ];

    const applyThemeColors = async () => {
      try {
        const root = document.documentElement;

        // Try to load from database
        try {
          const response = await fetch("/api/app-settings");
          if (response.ok) {
            const data = await response.json();
            const themeColors = data.themeColors;

            // Check if we have colors for at least one theme
            const hasLightColors =
              themeColors?.light && Object.keys(themeColors.light).length > 0;
            const hasDarkColors =
              themeColors?.dark && Object.keys(themeColors.dark).length > 0;

            if (hasLightColors || hasDarkColors) {
              // Clear all existing inline color styles
              allColorVars.forEach((varName) => {
                root.style.removeProperty(`--${varName}`);
              });

              // Apply the correct theme's colors
              const isDark = root.classList.contains("dark");
              const colorsToApply = isDark
                ? themeColors.dark || {}
                : themeColors.light || {};

              // If the current theme has no colors, clear styles to use CSS defaults
              if (Object.keys(colorsToApply).length === 0) {
                // Already cleared above, so CSS defaults will be used
                return;
              }

              Object.entries(colorsToApply).forEach(([key, value]) => {
                if (value) {
                  root.style.setProperty(`--${key}`, value);
                }
              });
              return; // Successfully loaded from database
            }
          }
        } catch (e) {
          console.error("Error loading colors from database:", e);
        }

        // Fallback to localStorage (for backward compatibility)
        const saved = localStorage.getItem("theme-colors");
        if (saved) {
          const parsed = JSON.parse(saved);

          if (parsed.light && parsed.dark) {
            allColorVars.forEach((varName) => {
              root.style.removeProperty(`--${varName}`);
            });

            const isDark = root.classList.contains("dark");
            const colorsToApply = isDark ? parsed.dark : parsed.light;

            Object.entries(colorsToApply).forEach(([key, value]) => {
              if (value) {
                root.style.setProperty(`--${key}`, value);
              }
            });
            return;
          }
        }

        // No saved colors - clear all inline styles to use CSS defaults
        allColorVars.forEach((varName) => {
          root.style.removeProperty(`--${varName}`);
        });
      } catch (e) {
        console.error("Error applying theme colors:", e);
      }
    };

    // Load colors on mount
    applyThemeColors();

    // Watch for theme changes (when dark class is added/removed)
    const observer = new MutationObserver((mutations) => {
      // Check if the class attribute actually changed
      const hasClassChange = mutations.some(
        (mutation) =>
          mutation.type === "attributes" && mutation.attributeName === "class"
      );

      if (hasClassChange) {
        // Small delay to ensure the class change is complete
        requestAnimationFrame(() => {
          applyThemeColors();
        });
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // Also listen for settings updates
    const handleSettingsUpdate = () => {
      applyThemeColors();
    };

    if (typeof window !== "undefined") {
      window.addEventListener("app-settings:updated", handleSettingsUpdate);
    }

    return () => {
      observer.disconnect();
      if (typeof window !== "undefined") {
        window.removeEventListener(
          "app-settings:updated",
          handleSettingsUpdate
        );
      }
    };
  }, []);
}
