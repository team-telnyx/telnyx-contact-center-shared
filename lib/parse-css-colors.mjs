import { readFileSync } from "fs";
import { join } from "path";
import { oklchToHex } from "./color-utils-server.mjs";

/**
 * Parse color values from globals.css file
 * Extracts both light and dark theme colors
 * @param {string} cssFilePath - Path to globals.css file
 * @returns {Object} { light: {colorKey: oklchValue}, dark: {colorKey: oklchValue}, lightHex: {...}, darkHex: {...} }
 */
export function parseColorsFromCSS(cssFilePath) {
  try {
    const cssContent = readFileSync(cssFilePath, "utf-8");
    const colors = {
      light: {},
      dark: {},
      lightHex: {},
      darkHex: {},
    };

    // List of all color variables we want to extract
    const colorKeys = [
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

    // Parse :root (light theme)
    const rootMatch = cssContent.match(/:root\s*\{([^}]+)\}/);
    if (rootMatch) {
      const rootContent = rootMatch[1];
      colorKeys.forEach((key) => {
        // Match --key: oklch(...);
        const regex = new RegExp(
          `--${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([^;]+);`,
          "i"
        );
        const match = rootContent.match(regex);
        if (match) {
          const oklchValue = match[1].trim();
          colors.light[key] = oklchValue;
          // Convert to hex
          const hex = oklchToHex(oklchValue);
          if (hex) {
            colors.lightHex[key] = hex;
          }
        }
      });
    }

    // Parse .dark (dark theme)
    const darkMatch = cssContent.match(/\.dark\s*\{([^}]+)\}/);
    if (darkMatch) {
      const darkContent = darkMatch[1];
      colorKeys.forEach((key) => {
        // Match --key: oklch(...);
        const regex = new RegExp(
          `--${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([^;]+);`,
          "i"
        );
        const match = darkContent.match(regex);
        if (match) {
          const oklchValue = match[1].trim();
          colors.dark[key] = oklchValue;
          // Convert to hex
          const hex = oklchToHex(oklchValue);
          if (hex) {
            colors.darkHex[key] = hex;
          }
        }
      });
    }

    return colors;
  } catch (error) {
    console.error("Error parsing CSS colors:", error);
    return {
      light: {},
      dark: {},
      lightHex: {},
      darkHex: {},
    };
  }
}
