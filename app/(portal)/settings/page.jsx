"use client";

import { useState, useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { useRouter, usePathname } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ColorPicker } from "@/components/ui/color-picker";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  IconPalette,
  IconRefresh,
  IconCheck,
  IconSun,
  IconMoon,
} from "@tabler/icons-react";
import {
  AdminPageHeader,
  AdminPageShell,
} from "@/components/contact-center/WorkspacePageLayout";
import { SystemSectionPage } from "@/components/admin/SystemSectionNav";
import {
  getDefaultColors,
  getDefaultDarkColors,
  oklchToRgb,
  rgbToHex,
} from "@/lib/color-utils";
import { notify } from "@/components/ToastNotify";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

const COLOR_GROUPS = [
  {
    title: "Base Colors",
    description: "Fundamental colors used throughout the application",
    colors: [
      { key: "background", label: "Background" },
      { key: "foreground", label: "Foreground" },
    ],
  },
  {
    title: "Card Colors",
    description: "Colors for card components",
    colors: [
      { key: "card", label: "Card" },
      { key: "card-foreground", label: "Card Foreground" },
    ],
  },
  {
    title: "Primary Colors",
    description: "Main brand and primary action colors",
    colors: [
      { key: "primary", label: "Primary" },
      { key: "primary-foreground", label: "Primary Foreground" },
      { key: "secondary", label: "Secondary" },
      { key: "secondary-foreground", label: "Secondary Foreground" },
    ],
  },
  {
    title: "Interactive Colors",
    description: "Colors for interactive elements",
    colors: [
      { key: "accent", label: "Accent" },
      { key: "accent-foreground", label: "Accent Foreground" },
      { key: "muted", label: "Muted" },
      { key: "muted-foreground", label: "Muted Foreground" },
      { key: "destructive", label: "Destructive" },
    ],
  },
  {
    title: "Border & Input Colors",
    description: "Colors for borders and input fields",
    colors: [
      { key: "border", label: "Border" },
      { key: "input", label: "Input" },
      { key: "ring", label: "Ring" },
    ],
  },
  {
    title: "Chart Colors",
    description: "Colors for charts and data visualization",
    colors: [
      { key: "chart-1", label: "Chart 1" },
      { key: "chart-2", label: "Chart 2" },
      { key: "chart-3", label: "Chart 3" },
      { key: "chart-4", label: "Chart 4" },
      { key: "chart-5", label: "Chart 5" },
    ],
  },
  {
    title: "Sidebar Colors",
    description: "Colors for the sidebar navigation",
    colors: [
      { key: "sidebar", label: "Sidebar" },
      { key: "sidebar-foreground", label: "Sidebar Foreground" },
      { key: "sidebar-primary", label: "Sidebar Primary" },
      {
        key: "sidebar-primary-foreground",
        label: "Sidebar Primary Foreground",
      },
      { key: "sidebar-accent", label: "Sidebar Accent" },
      { key: "sidebar-accent-foreground", label: "Sidebar Accent Foreground" },
      { key: "sidebar-border", label: "Sidebar Border" },
      { key: "sidebar-ring", label: "Sidebar Ring" },
    ],
  },
  {
    title: "Modal Colors",
    description: "Colors for modal dialogs and alert dialogs",
    colors: [
      { key: "modal", label: "Modal Background" },
      { key: "modal-foreground", label: "Modal Foreground" },
      { key: "modal-border", label: "Modal Border" },
    ],
  },
  {
    title: "Sheet Colors",
    description: "Colors for sheet components (side panels)",
    colors: [
      { key: "sheet", label: "Sheet Background" },
      { key: "sheet-foreground", label: "Sheet Foreground" },
      { key: "sheet-border", label: "Sheet Border" },
    ],
  },
  {
    title: "Popover Colors",
    description: "Colors for popover components",
    colors: [
      { key: "popover", label: "Popover" },
      { key: "popover-foreground", label: "Popover Foreground" },
    ],
  },
  {
    title: "Brand Colors",
    description: "Customizable brand colors",
    colors: [
      { key: "brand-primary", label: "Brand Primary" },
      { key: "brand-secondary", label: "Brand Secondary" },
      { key: "brand-background", label: "Brand Background" },
    ],
  },
];

export default function SettingsPage() {
  const [lightColors, setLightColors] = useState({});
  const [darkColors, setDarkColors] = useState({});
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState(null);
  const [activeTheme, setActiveTheme] = useState("light");
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();

  // Sync activeTheme with actual theme
  useEffect(() => {
    if (theme && theme !== "system") {
      setActiveTheme(theme);
    } else {
      // If theme is "system", check the actual class
      const isDark = document.documentElement.classList.contains("dark");
      setActiveTheme(isDark ? "dark" : "light");
    }
  }, [theme]);

  // Handle tab change - update both local state and actual theme
  const handleThemeTabChange = (newTheme) => {
    setActiveTheme(newTheme);
    setTheme(newTheme);
  };

  const [brandName, setBrandName] = useState("");
  const [brandLogoUri, setBrandLogoUri] = useState(null);
  const [authRightImageUri, setAuthRightImageUri] = useState(null);
  const [sidebarLogoUri, setSidebarLogoUri] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lightColorsHex, setLightColorsHex] = useState({});
  const [darkColorsHex, setDarkColorsHex] = useState({});

  const brandLogoInputRef = useRef(null);
  const authRightInputRef = useRef(null);
  const sidebarLogoInputRef = useRef(null);
  // Last brand name persisted to the DB. Reset to Defaults restores the field to
  // this (discarding a pending edit) instead of clearing it, so a color reset
  // never wipes the configured company brand.
  const lastSavedBrandNameRef = useRef("");

  useEffect(() => {
    // Load settings from database
    const loadSettings = async () => {
      try {
        const response = await fetch("/api/app-settings");
        if (response.ok) {
          const data = await response.json();
          // Always merge with defaults to ensure all colors are present
          const lightDefaults = getDefaultColors();
          const darkDefaults = getDefaultDarkColors();

          // Merge saved colors with defaults (saved colors take precedence, but defaults fill gaps)
          const mergedLight = {
            ...lightDefaults,
            ...(data.themeColors?.light || {}),
          };
          const mergedDark = {
            ...darkDefaults,
            ...(data.themeColors?.dark || {}),
          };

          setLightColors(mergedLight);
          setDarkColors(mergedDark);

          // Load hex values if available, otherwise convert
          const lightHex = { ...(data.themeColorsHex?.light || {}) };
          const darkHex = { ...(data.themeColorsHex?.dark || {}) };

          // Fill in missing hex values by converting OKLCH
          Object.keys(mergedLight).forEach((key) => {
            if (
              !lightHex[key] &&
              mergedLight[key] &&
              typeof window !== "undefined"
            ) {
              const rgb = oklchToRgb(mergedLight[key]);
              if (rgb) {
                lightHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
              }
            }
          });

          Object.keys(mergedDark).forEach((key) => {
            if (
              !darkHex[key] &&
              mergedDark[key] &&
              typeof window !== "undefined"
            ) {
              const rgb = oklchToRgb(mergedDark[key]);
              if (rgb) {
                darkHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
              }
            }
          });

          setLightColorsHex(lightHex);
          setDarkColorsHex(darkHex);
          applyColors(mergedLight, mergedDark);

          // If no colors were saved, save the defaults now
          if (
            !data.themeColors?.light ||
            !data.themeColors?.dark ||
            Object.keys(data.themeColors.light || {}).length === 0 ||
            Object.keys(data.themeColors.dark || {}).length === 0
          ) {
            // Auto-save defaults to database
            fetch("/api/app-settings", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                themeColors: { light: mergedLight, dark: mergedDark },
                themeColorsHex: { light: lightHex, dark: darkHex },
                brandLogoUri: data.brandLogoUri || null,
                authRightImageUri: data.authRightImageUri || null,
                sidebarLogoUri: data.sidebarLogoUri || null,
              }),
            }).catch((e) => console.error("Error auto-saving defaults:", e));
          }
          setBrandName(data.brandName || "");
          lastSavedBrandNameRef.current = data.brandName || "";
          setBrandLogoUri(data.brandLogoUri);
          setAuthRightImageUri(data.authRightImageUri);
          setSidebarLogoUri(data.sidebarLogoUri);
        } else {
          // Fallback to defaults if API fails
          const lightDefaults = getDefaultColors();
          const darkDefaults = getDefaultDarkColors();
          setLightColors(lightDefaults);
          setDarkColors(darkDefaults);
          // Convert to hex
          const lightHex = {};
          const darkHex = {};
          Object.entries(lightDefaults).forEach(([key, oklch]) => {
            if (oklch && typeof window !== "undefined") {
              const rgb = oklchToRgb(oklch);
              if (rgb) {
                lightHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
              }
            }
          });
          Object.entries(darkDefaults).forEach(([key, oklch]) => {
            if (oklch && typeof window !== "undefined") {
              const rgb = oklchToRgb(oklch);
              if (rgb) {
                darkHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
              }
            }
          });
          setLightColorsHex(lightHex);
          setDarkColorsHex(darkHex);
        }
      } catch (e) {
        console.error("Error loading settings:", e);
        // Fallback to defaults
        const lightDefaults = getDefaultColors();
        const darkDefaults = getDefaultDarkColors();
        setLightColors(lightDefaults);
        setDarkColors(darkDefaults);
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, []);

  const applyColors = (lightColorMap, darkColorMap) => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const isDark = root.classList.contains("dark");

    // Apply colors based on current theme
    if (isDark && darkColorMap) {
      Object.entries(darkColorMap).forEach(([key, value]) => {
        root.style.setProperty(`--${key}`, value);
      });
    } else if (lightColorMap) {
      Object.entries(lightColorMap).forEach(([key, value]) => {
        root.style.setProperty(`--${key}`, value);
      });
    }
  };

  // Watch for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const root = document.documentElement;
      if (root.classList.contains("dark")) {
        Object.entries(darkColors).forEach(([key, value]) => {
          root.style.setProperty(`--${key}`, value);
        });
      } else {
        Object.entries(lightColors).forEach(([key, value]) => {
          root.style.setProperty(`--${key}`, value);
        });
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, [lightColors, darkColors]);

  // Handle browser navigation (refresh, close tab, etc.)
  useEffect(() => {
    if (!hasChanges) return;

    const handleBeforeUnload = (e) => {
      e.preventDefault();
      // Modern browsers ignore custom messages, but we still need to call preventDefault
      e.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [hasChanges]);

  // Handle in-app navigation by intercepting link clicks
  useEffect(() => {
    if (!hasChanges) return;

    const handleLinkClick = (e) => {
      const link = e.target.closest("a");
      if (link && link.href) {
        try {
          const url = new URL(link.href);
          // Only intercept if it's a different path and not an anchor link
          // Also check if it's a same-origin link
          if (
            url.pathname !== pathname &&
            !url.hash &&
            url.origin === window.location.origin &&
            hasChanges &&
            !isSaving
          ) {
            e.preventDefault();
            e.stopPropagation();
            setPendingNavigation(() => () => {
              window.location.href = link.href;
            });
            setShowLeaveDialog(true);
          }
        } catch (err) {
          // Invalid URL, ignore
        }
      }
    };

    document.addEventListener("click", handleLinkClick, true);

    return () => {
      document.removeEventListener("click", handleLinkClick, true);
    };
  }, [hasChanges, isSaving, pathname]);

  // Handle leave confirmation
  const handleLeaveConfirm = () => {
    setHasChanges(false);
    setShowLeaveDialog(false);
    const nav = pendingNavigation;
    setPendingNavigation(null);

    // Execute navigation after state updates
    if (nav) {
      // Use setTimeout to ensure state updates complete first
      setTimeout(() => {
        nav();
      }, 0);
    }
  };

  const handleLeaveCancel = () => {
    setShowLeaveDialog(false);
    setPendingNavigation(null);
  };

  const handleColorChange = (key, value, theme, hexValue) => {
    if (theme === "light") {
      const newColors = { ...lightColors, [key]: value };
      const newHex = { ...lightColorsHex, [key]: hexValue || "" };
      setLightColors(newColors);
      setLightColorsHex(newHex);
      if (!document.documentElement.classList.contains("dark")) {
        applyColors(newColors, darkColors);
      }
    } else {
      const newColors = { ...darkColors, [key]: value };
      const newHex = { ...darkColorsHex, [key]: hexValue || "" };
      setDarkColors(newColors);
      setDarkColorsHex(newHex);
      if (document.documentElement.classList.contains("dark")) {
        applyColors(lightColors, newColors);
      }
    }
    setHasChanges(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Get defaults to ensure we have all colors
      const lightDefaults = getDefaultColors();
      const darkDefaults = getDefaultDarkColors();

      // Merge current colors with defaults to ensure ALL colors are present
      // User's changes take precedence, but defaults fill any gaps
      const completeLightColors = {
        ...lightDefaults,
        ...lightColors,
      };
      const completeDarkColors = {
        ...darkDefaults,
        ...darkColors,
      };

      // Ensure ALL colors have hex values - convert any missing ones
      // Start with existing hex values, then fill gaps
      const completeLightHex = { ...lightColorsHex };
      const completeDarkHex = { ...darkColorsHex };

      // Get all color keys from defaults to ensure we save everything
      const allColorKeys = [
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

      // Convert all light colors to hex (including defaults)
      allColorKeys.forEach((key) => {
        const oklch = completeLightColors[key];
        if (oklch && typeof window !== "undefined") {
          if (!completeLightHex[key]) {
            const rgb = oklchToRgb(oklch);
            if (rgb) {
              completeLightHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
            }
          }
        }
      });

      // Convert all dark colors to hex (including defaults)
      allColorKeys.forEach((key) => {
        const oklch = completeDarkColors[key];
        if (oklch && typeof window !== "undefined") {
          if (!completeDarkHex[key]) {
            const rgb = oklchToRgb(oklch);
            if (rgb) {
              completeDarkHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
            }
          }
        }
      });

      const response = await fetch("/api/app-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          themeColors: { light: completeLightColors, dark: completeDarkColors },
          themeColorsHex: { light: completeLightHex, dark: completeDarkHex },
          // Only send brandName when the admin actually edited it. For a
          // color/logo-only save we OMIT it so the PUT preserves whatever brand
          // is currently in the DB (which another admin may have changed after
          // this page loaded) instead of overwriting it with a stale value.
          ...(brandName !== lastSavedBrandNameRef.current ? { brandName } : {}),
          brandLogoUri,
          authRightImageUri,
          sidebarLogoUri,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save settings");
      }

      lastSavedBrandNameRef.current = brandName;

      // Update state with complete colors to keep UI in sync
      setLightColors(completeLightColors);
      setDarkColors(completeDarkColors);
      setLightColorsHex(completeLightHex);
      setDarkColorsHex(completeDarkHex);

      setHasChanges(false);

      // Dispatch event to notify all users of settings update
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("app-settings:updated"));
      }

      notify({
        title: "Settings saved",
        description: "Settings saved successfully and applied to all users!",
        variant: "success",
        autoCloseMs: 3000,
      });
    } catch (e) {
      console.error("Error saving settings:", e);
      notify({
        title: "Save failed",
        description: "Failed to save settings",
        variant: "error",
        autoCloseMs: 3000,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setShowResetDialog(true);
  };

  const confirmReset = async () => {
    // First, clear all inline color styles to get original CSS defaults
    if (typeof window !== "undefined") {
      const root = document.documentElement;
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

      // Remove all inline color styles
      allColorVars.forEach((varName) => {
        root.style.removeProperty(`--${varName}`);
      });
    }

    // Try to get defaults from database first (seeded values), fallback to CSS
    let lightDefaults = {};
    let darkDefaults = {};
    let lightDefaultsHex = {};
    let darkDefaultsHex = {};

    try {
      const response = await fetch("/api/app-settings");
      if (response.ok) {
        const data = await response.json();
        // Check if we have seeded defaults in the database
        // If the database has empty colors but we're resetting, we should use CSS defaults
        const dbLightColors = data.themeColors?.light || {};
        const dbDarkColors = data.themeColors?.dark || {};
        const dbLightHex = data.themeColorsHex?.light || {};
        const dbDarkHex = data.themeColorsHex?.dark || {};

        // If database has colors, use them (they should be the seeded defaults)
        // Otherwise, get from CSS
        if (
          Object.keys(dbLightColors).length > 0 &&
          Object.keys(dbDarkColors).length > 0
        ) {
          lightDefaults = dbLightColors;
          darkDefaults = dbDarkColors;
          lightDefaultsHex = dbLightHex;
          darkDefaultsHex = dbDarkHex;
          console.log("Reset: Using defaults from database");
        } else {
          // Fallback to CSS
          lightDefaults = getDefaultColors();
          darkDefaults = getDefaultDarkColors();
          console.log("Reset: Using defaults from CSS (database empty)");
        }
      } else {
        // Fallback to CSS
        lightDefaults = getDefaultColors();
        darkDefaults = getDefaultDarkColors();
        console.log("Reset: Using defaults from CSS (API failed)");
      }
    } catch (e) {
      // Fallback to CSS
      console.error("Error fetching defaults from database:", e);
      lightDefaults = getDefaultColors();
      darkDefaults = getDefaultDarkColors();
      console.log("Reset: Using defaults from CSS (error)");
    }

    // Get all color keys to ensure we convert ALL colors to hex
    const allColorKeys = [
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

    // If we got defaults from database with hex values, use them
    // Otherwise, convert from OKLCH
    if (
      Object.keys(lightDefaultsHex).length === 0 ||
      Object.keys(darkDefaultsHex).length === 0
    ) {
      // Need to convert OKLCH to hex
      // Convert ALL defaults to hex - ensure every color has a hex value
      allColorKeys.forEach((key) => {
        const lightOklch = lightDefaults[key];
        if (lightOklch && typeof window !== "undefined") {
          try {
            const rgb = oklchToRgb(lightOklch);
            if (rgb) {
              lightDefaultsHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
            } else {
              console.warn(
                `Failed to convert light color ${key}: ${lightOklch}`
              );
            }
          } catch (e) {
            console.error(`Error converting light color ${key}:`, e);
          }
        } else {
          console.warn(`Missing light default color for ${key}`);
        }
      });

      allColorKeys.forEach((key) => {
        const darkOklch = darkDefaults[key];
        if (darkOklch && typeof window !== "undefined") {
          try {
            const rgb = oklchToRgb(darkOklch);
            if (rgb) {
              darkDefaultsHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
            } else {
              console.warn(`Failed to convert dark color ${key}: ${darkOklch}`);
            }
          } catch (e) {
            console.error(`Error converting dark color ${key}:`, e);
          }
        } else {
          console.warn(`Missing dark default color for ${key}`);
        }
      });

      // Log how many hex values we have
      console.log(
        `Reset: Converted ${
          Object.keys(lightDefaultsHex).length
        } light hex values and ${
          Object.keys(darkDefaultsHex).length
        } dark hex values`
      );
    } else {
      console.log(
        `Reset: Using hex values from database: ${
          Object.keys(lightDefaultsHex).length
        } light, ${Object.keys(darkDefaultsHex).length} dark`
      );
    }

    // Apply the defaults immediately to the page
    applyColors(lightDefaults, darkDefaults);

    // Ensure we have all colors and hex values before saving
    // Merge with defaults to ensure completeness (though defaults should already be complete)
    const completeLightColors = {
      ...lightDefaults,
    };
    const completeDarkColors = {
      ...darkDefaults,
    };
    const completeLightHex = {
      ...lightDefaultsHex,
    };
    const completeDarkHex = {
      ...darkDefaultsHex,
    };

    // Convert any missing hex values (shouldn't be needed, but just in case)
    allColorKeys.forEach((key) => {
      const oklch = completeLightColors[key];
      if (oklch && typeof window !== "undefined") {
        if (!completeLightHex[key]) {
          const rgb = oklchToRgb(oklch);
          if (rgb) {
            completeLightHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
          }
        }
      }
    });

    allColorKeys.forEach((key) => {
      const oklch = completeDarkColors[key];
      if (oklch && typeof window !== "undefined") {
        if (!completeDarkHex[key]) {
          const rgb = oklchToRgb(oklch);
          if (rgb) {
            completeDarkHex[key] = rgbToHex(rgb.r, rgb.g, rgb.b);
          }
        }
      }
    });

    // Log what we're about to save
    console.log("Reset: Saving to database:", {
      lightColorsCount: Object.keys(completeLightColors).length,
      darkColorsCount: Object.keys(completeDarkColors).length,
      lightHexCount: Object.keys(completeLightHex).length,
      darkHexCount: Object.keys(completeDarkHex).length,
    });

    // Save complete defaults to database
    fetch("/api/app-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        themeColors: { light: completeLightColors, dark: completeDarkColors },
        themeColorsHex: { light: completeLightHex, dark: completeDarkHex },
        // brandName is intentionally OMITTED so the reset preserves the configured
        // company brand (it's org identity, not a color). The local field is
        // restored to the saved value below, so no stale edit survives the reset.
        brandLogoUri: null,
        authRightImageUri: null,
        sidebarLogoUri: null,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            "Error resetting settings:",
            response.statusText,
            errorText
          );
        } else {
          const result = await response.json();
          console.log("Reset: Successfully saved to database", result);
          // Update state with complete values
          setLightColors(completeLightColors);
          setDarkColors(completeDarkColors);
          setLightColorsHex(completeLightHex);
          setDarkColorsHex(completeDarkHex);
        }
      })
      .catch((e) => console.error("Error resetting settings:", e));

    // Restore the brand field to the last-saved value (discard any pending edit)
    // rather than clearing it — a color reset must not wipe the company brand.
    setBrandName(lastSavedBrandNameRef.current);
    setBrandLogoUri(null);
    setAuthRightImageUri(null);
    setSidebarLogoUri(null);
    setHasChanges(false);
    setShowResetDialog(false);

    notify({
      title: "Colors reset",
      description: "Colors reset to defaults",
      variant: "success",
      autoCloseMs: 3000,
    });
  };

  // Handle image upload
  const handleImageUpload = async (file, type) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        if (type === "brand") {
          setBrandLogoUri(dataUrl);
        } else if (type === "authRight") {
          setAuthRightImageUri(dataUrl);
        } else if (type === "sidebar") {
          setSidebarLogoUri(dataUrl);
        }
        setHasChanges(true);
      };
      reader.readAsDataURL(file);
    } catch (error) {
      notify({
        title: "Upload failed",
        description: "Failed to process image",
        variant: "error",
      });
    }
  };

  // Handle image removal
  const handleImageRemove = (type) => {
    if (type === "brand") {
      setBrandLogoUri(null);
    } else if (type === "authRight") {
      setAuthRightImageUri(null);
    } else if (type === "sidebar") {
      setSidebarLogoUri(null);
    }
    setHasChanges(true);
  };

  const currentColors = activeTheme === "light" ? lightColors : darkColors;

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="Theme Settings"
        badges={
          <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-300">
            Branding & colors
          </span>
        }
        actions={
          <>
            <Button variant="outline" onClick={handleReset} disabled={isSaving}>
              <IconRefresh className="size-4 mr-2" />
              Reset to Defaults
            </Button>
            <Button
              variant="secondary"
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
              className="border border-border/70 bg-foreground text-background hover:bg-foreground/90"
            >
              {isSaving ? (
                "Saving..."
              ) : (
                <>
                  <IconCheck className="size-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </>
        }
      />
      <SystemSectionPage activeId="theme-settings" contentClassName="space-y-6 overflow-y-auto pr-1">
        {/* Branding Section */}
        <Card>
        <CardHeader>
          <CardTitle>Branding & Logos</CardTitle>
          <CardDescription>
            Upload logos to customize the appearance of authentication pages and
            sidebar
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Brand / company name (used in agent-assist suggested-response greetings) */}
          <div className="space-y-2">
            <Label htmlFor="brand-name">Brand / Company Name</Label>
            <p className="text-sm text-muted-foreground">
              Used in agent-assist greetings, e.g. &ldquo;Thanks for calling{" "}
              {brandName?.trim() || "<your company>"}.&rdquo;
            </p>
            <Input
              id="brand-name"
              value={brandName}
              onChange={(e) => {
                setBrandName(e.target.value);
                setHasChanges(true);
              }}
              placeholder="e.g. Global Medical Response"
              className="max-w-md"
            />
          </div>

          {/* Brand Logo (Auth Pages Left Side) */}
          <div className="space-y-2">
            <Label>Brand Logo (Auth Pages)</Label>
            <p className="text-sm text-muted-foreground">
              Logo displayed on the left side of sign-in and sign-up pages
            </p>
            <div className="flex items-center gap-4">
              <div className="relative">
                <img
                  src={brandLogoUri || "/auth_brand_logo.png"}
                  alt="Brand Logo"
                  className="h-16 w-auto object-contain border rounded p-2"
                />
                {brandLogoUri && (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="absolute -top-2 -right-2"
                    onClick={() => handleImageRemove("brand")}
                  >
                    ×
                  </Button>
                )}
              </div>
              <input
                ref={brandLogoInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImageUpload(file, "brand");
                }}
                className="hidden"
                id="brand-logo-upload"
              />
              <Button
                variant="outline"
                type="button"
                onClick={() => brandLogoInputRef.current?.click()}
              >
                {brandLogoUri ? "Change Logo" : "Upload Logo"}
              </Button>
            </div>
          </div>

          {/* Auth Right Image */}
          <div className="space-y-2">
            <Label>Right Panel Image (Auth Pages)</Label>
            <p className="text-sm text-muted-foreground">
              Image displayed on the right panel of sign-in and sign-up pages
            </p>
            <div className="flex items-center gap-4">
              <div className="relative">
                <img
                  src={authRightImageUri || "/auth_right_image.png"}
                  alt="Auth Right Image"
                  className="h-32 w-48 object-cover border rounded"
                />
                {authRightImageUri && (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="absolute -top-2 -right-2"
                    onClick={() => handleImageRemove("authRight")}
                  >
                    ×
                  </Button>
                )}
              </div>
              <input
                ref={authRightInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImageUpload(file, "authRight");
                }}
                className="hidden"
                id="auth-right-upload"
              />
              <Button
                variant="outline"
                type="button"
                onClick={() => authRightInputRef.current?.click()}
              >
                {authRightImageUri ? "Change Image" : "Upload Image"}
              </Button>
            </div>
          </div>

          {/* Sidebar Logo */}
          <div className="space-y-2">
            <Label>Sidebar Logo</Label>
            <p className="text-sm text-muted-foreground">
              Logo displayed at the top of the sidebar after authentication
            </p>
            <div className="flex items-center gap-4">
              <div className="relative">
                <img
                  src={sidebarLogoUri || "/sidebar_logo.png"}
                  alt="Sidebar Logo"
                  className="h-12 w-auto object-contain border rounded p-2"
                />
                {sidebarLogoUri && (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="absolute -top-2 -right-2"
                    onClick={() => handleImageRemove("sidebar")}
                  >
                    ×
                  </Button>
                )}
              </div>
              <input
                ref={sidebarLogoInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImageUpload(file, "sidebar");
                }}
                className="hidden"
                id="sidebar-logo-upload"
              />
              <Button
                variant="outline"
                type="button"
                onClick={() => sidebarLogoInputRef.current?.click()}
              >
                {sidebarLogoUri ? "Change Logo" : "Upload Logo"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs
        value={activeTheme}
        onValueChange={handleThemeTabChange}
        className="w-full"
      >
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="light" className="flex items-center gap-2">
            <IconSun className="size-4" />
            Light Theme
          </TabsTrigger>
          <TabsTrigger value="dark" className="flex items-center gap-2">
            <IconMoon className="size-4" />
            Dark Theme
          </TabsTrigger>
        </TabsList>

        <TabsContent value="light" className="mt-6">
          <div className="grid gap-6">
            {COLOR_GROUPS.map((group) => (
              <Card key={group.title}>
                <CardHeader>
                  <CardTitle>{group.title}</CardTitle>
                  <CardDescription>{group.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {group.colors.map((color) => (
                      <ColorPicker
                        key={color.key}
                        label={color.label}
                        value={lightColors[color.key] || ""}
                        initialHex={lightColorsHex[color.key] || undefined}
                        onChange={(value, hexValue) =>
                          handleColorChange(color.key, value, "light", hexValue)
                        }
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="dark" className="mt-6">
          <div className="grid gap-6">
            {COLOR_GROUPS.map((group) => (
              <Card key={group.title}>
                <CardHeader>
                  <CardTitle>{group.title}</CardTitle>
                  <CardDescription>{group.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {group.colors.map((color) => (
                      <ColorPicker
                        key={color.key}
                        label={color.label}
                        value={darkColors[color.key] || ""}
                        initialHex={darkColorsHex[color.key] || undefined}
                        onChange={(value, hexValue) =>
                          handleColorChange(color.key, value, "dark", hexValue)
                        }
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {hasChanges && (
        <div className="fixed bottom-4 right-4 bg-card border border-border rounded-lg shadow-lg p-4">
          <p className="text-sm text-muted-foreground">
            You have unsaved changes. Don't forget to save!
          </p>
        </div>
      )}

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Colors to Defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to reset all colors to their default values?
              This action cannot be undone and will remove all your custom color
              settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmReset}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Reset to Defaults
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Are you sure you want to leave this
              page? Your changes will be lost if you don't save them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleLeaveCancel}>
              Stay on Page
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLeaveConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Leave Without Saving
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </SystemSectionPage>
    </AdminPageShell>
  );
}
