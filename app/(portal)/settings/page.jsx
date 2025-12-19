"use client";

import { useState, useEffect } from "react";
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
import { getDefaultColors, getDefaultDarkColors } from "@/lib/color-utils";
import { notify } from "@/components/ToastNotify";

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
  const [activeTheme, setActiveTheme] = useState("light");

  useEffect(() => {
    // Load colors from localStorage or defaults
    const loadColors = () => {
      try {
        const saved = localStorage.getItem("theme-colors");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.light && parsed.dark) {
            setLightColors(parsed.light);
            setDarkColors(parsed.dark);
            applyColors(parsed.light, parsed.dark);
          } else {
            // Legacy format - migrate to new format
            const lightDefaults = getDefaultColors();
            const darkDefaults = getDefaultDarkColors();
            setLightColors(lightDefaults);
            setDarkColors(darkDefaults);
            applyColors(lightDefaults, darkDefaults);
          }
        } else {
          const lightDefaults = getDefaultColors();
          const darkDefaults = getDefaultDarkColors();
          setLightColors(lightDefaults);
          setDarkColors(darkDefaults);
        }
      } catch (e) {
        console.error("Error loading colors:", e);
        const lightDefaults = getDefaultColors();
        const darkDefaults = getDefaultDarkColors();
        setLightColors(lightDefaults);
        setDarkColors(darkDefaults);
      }
    };

    loadColors();
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

  const handleColorChange = (key, value, theme) => {
    if (theme === "light") {
      const newColors = { ...lightColors, [key]: value };
      setLightColors(newColors);
      if (!document.documentElement.classList.contains("dark")) {
        applyColors(newColors, darkColors);
      }
    } else {
      const newColors = { ...darkColors, [key]: value };
      setDarkColors(newColors);
      if (document.documentElement.classList.contains("dark")) {
        applyColors(lightColors, newColors);
      }
    }
    setHasChanges(true);
  };

  const handleSave = () => {
    setIsSaving(true);
    try {
      localStorage.setItem(
        "theme-colors",
        JSON.stringify({ light: lightColors, dark: darkColors })
      );
      setHasChanges(false);
      notify({
        title: "Settings saved",
        description: "Color settings saved successfully!",
        variant: "success",
        autoCloseMs: 3000,
      });
    } catch (e) {
      console.error("Error saving colors:", e);
      notify({
        title: "Save failed",
        description: "Failed to save color settings",
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

  const confirmReset = () => {
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

    // Get actual defaults from CSS (light and dark separately)
    const lightDefaults = getDefaultColors();
    const darkDefaults = getDefaultDarkColors();

    // Update state with defaults
    setLightColors(lightDefaults);
    setDarkColors(darkDefaults);

    // Apply the defaults immediately to the page
    applyColors(lightDefaults, darkDefaults);

    // Clear saved colors
    localStorage.removeItem("theme-colors");
    setHasChanges(false);
    setShowResetDialog(false);

    notify({
      title: "Colors reset",
      description: "Colors reset to defaults",
      variant: "success",
      autoCloseMs: 3000,
    });
  };

  const currentColors = activeTheme === "light" ? lightColors : darkColors;

  return (
    <div className="container mx-auto px-4 md:px-6 lg:px-8 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <IconPalette className="size-8 text-brand-primary" />
            Theme Settings
          </h1>
          <p className="text-muted-foreground mt-2">
            Customize the color scheme of your contact center
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset} disabled={isSaving}>
            <IconRefresh className="size-4 mr-2" />
            Reset to Defaults
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className="bg-brand-primary hover:bg-brand-primary/90 text-black"
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
        </div>
      </div>

      <Tabs
        value={activeTheme}
        onValueChange={setActiveTheme}
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
                        onChange={(value) =>
                          handleColorChange(color.key, value, "light")
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
                        onChange={(value) =>
                          handleColorChange(color.key, value, "dark")
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
    </div>
  );
}
