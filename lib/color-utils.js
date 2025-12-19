/**
 * Utility functions for color conversion between OKLCH and other formats
 * Uses browser's native color parsing for accuracy
 */

/**
 * Convert OKLCH to RGB using browser's native color parsing
 * @param {string} oklchString - OKLCH string like "oklch(81.25% 0.167 166.68)"
 * @returns {Object} {r, g, b} values 0-255
 */
export function oklchToRgb(oklchString) {
  if (typeof window === "undefined") return null;

  try {
    // Validate OKLCH format
    if (!oklchString || typeof oklchString !== "string") return null;

    // Ensure document.body exists
    if (!document.body) {
      // Wait a bit and retry if body doesn't exist yet
      return null;
    }

    // Create a temporary element to use browser's color parsing
    const temp = document.createElement("div");
    temp.style.color = oklchString;
    temp.style.position = "absolute";
    temp.style.visibility = "hidden";
    temp.style.pointerEvents = "none";
    document.body.appendChild(temp);

    // Force a reflow to ensure the style is applied
    void temp.offsetHeight;

    const computed = window.getComputedStyle(temp);
    const rgbString = computed.color;
    document.body.removeChild(temp);

    // Parse rgb(r, g, b) string
    const match = rgbString.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      const r = parseInt(match[1], 10);
      const g = parseInt(match[2], 10);
      const b = parseInt(match[3], 10);

      // Verify we got valid RGB values
      // Only reject black if we can confirm it's an error (lightness > 10% but got black)
      const lightnessMatch = oklchString.match(/oklch\(([\d.]+)%/);
      if (lightnessMatch) {
        const lightness = parseFloat(lightnessMatch[1]);
        // If lightness is > 10% but we got pure black, it's probably an error
        if (lightness > 10 && r === 0 && g === 0 && b === 0) {
          return null;
        }
      }

      return { r, g, b };
    }
  } catch (e) {
    console.error("Error converting OKLCH to RGB:", e, oklchString);
  }

  return null;
}

/**
 * Convert RGB to OKLCH using browser's native color conversion
 * Uses the browser's CSS color parsing to get accurate OKLCH values
 * @param {number} r - Red 0-255
 * @param {number} g - Green 0-255
 * @param {number} b - Blue 0-255
 * @param {string} originalOklch - Original OKLCH value to preserve if available
 * @returns {string} OKLCH string
 */
export function rgbToOklch(r, g, b, originalOklch = null) {
  // Always use the accurate conversion algorithm for precise color matching
  return accurateRgbToOklch(r, g, b);
}

/**
 * Accurate RGB to OKLCH conversion using proper OKLab algorithm
 * Based on the OKLab color space specification (goes through LMS space)
 */
function accurateRgbToOklch(r, g, b) {
  // Normalize RGB to 0-1
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;

  // Convert sRGB to linear RGB
  const toLinear = (c) =>
    c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  const rLin = toLinear(rNorm);
  const gLin = toLinear(gNorm);
  const bLin = toLinear(bNorm);

  // Convert linear RGB to LMS (Long, Medium, Short cone response)
  const l = 0.4122214708 * rLin + 0.5363325363 * gLin + 0.0514459929 * bLin;
  const m = 0.2119034982 * rLin + 0.6806995451 * gLin + 0.1073969566 * bLin;
  const s = 0.0883024619 * rLin + 0.2817188376 * gLin + 0.6299787005 * bLin;

  // Apply cube root to LMS
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  // Convert LMS to OKLab
  const L_ok = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a_ok = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b_ok = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  // Convert OKLab to OKLCH
  const c = Math.sqrt(a_ok * a_ok + b_ok * b_ok);
  let h = (Math.atan2(b_ok, a_ok) * 180) / Math.PI;
  if (h < 0) h += 360;

  // Convert L from 0-1 range to percentage (0-100)
  const lPercent = Math.max(0, Math.min(100, L_ok * 100));

  return `oklch(${lPercent.toFixed(2)}% ${c.toFixed(3)} ${h.toFixed(2)})`;
}

/**
 * Approximate RGB to OKLCH conversion
 * This is a simplified conversion - for production, consider using a proper color library
 */
function approximateRgbToOklch(r, g, b) {
  // Normalize RGB
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;

  // Convert to linear RGB
  const toLinear = (c) =>
    c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  const rLin = toLinear(rNorm);
  const gLin = toLinear(gNorm);
  const bLin = toLinear(bNorm);

  // Convert to XYZ (D65)
  let x = rLin * 0.4124564 + gLin * 0.3575761 + bLin * 0.1804375;
  let y = rLin * 0.2126729 + gLin * 0.7151522 + bLin * 0.072175;
  let z = rLin * 0.0193339 + gLin * 0.119192 + bLin * 0.9503041;

  // Normalize by D65 white point
  x /= 0.95047;
  z /= 1.08883;

  // Convert to Lab
  const f = (t) => (t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  const l = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const b_val = 200 * (fy - fz);

  // Approximate OKLab (simplified - OKLab is similar to Lab but with different coefficients)
  // For a more accurate conversion, use a proper color library
  const l_ok = l;
  const a_ok = a * 1.0; // Simplified
  const b_ok = b_val * 1.0; // Simplified

  // Convert to OKLCH
  const c = Math.sqrt(a_ok * a_ok + b_ok * b_ok);
  let h = (Math.atan2(b_ok, a_ok) * 180) / Math.PI;
  if (h < 0) h += 360;

  // Format with appropriate precision
  const lPercent = Math.max(0, Math.min(100, l_ok));

  return `oklch(${lPercent.toFixed(2)}% ${c.toFixed(3)} ${h.toFixed(2)})`;
}

/**
 * Convert RGB to hex
 */
export function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
  );
}

/**
 * Convert hex to RGB
 */
export function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Get default color values from CSS
 * Returns both light and dark theme defaults
 */
export function getDefaultColors() {
  if (typeof window === "undefined") return {};

  const root = document.documentElement;
  const colors = {};

  // Get all CSS custom properties that start with --
  const colorVars = [
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

  // Get defaults from :root (light theme)
  // We need to temporarily remove any inline styles to get the original CSS values
  const originalStyles = {};
  colorVars.forEach((varName) => {
    const inlineValue = root.style.getPropertyValue(`--${varName}`);
    if (inlineValue) {
      originalStyles[varName] = inlineValue;
      root.style.removeProperty(`--${varName}`);
    }
  });

  // Now read from computed styles (which will use CSS defaults)
  const computedStyle = getComputedStyle(root);
  colorVars.forEach((varName) => {
    const value = computedStyle.getPropertyValue(`--${varName}`).trim();
    if (value) {
      colors[varName] = value;
    }
  });

  // Restore inline styles if they existed
  Object.entries(originalStyles).forEach(([varName, value]) => {
    root.style.setProperty(`--${varName}`, value);
  });

  return colors;
}

/**
 * Get default dark theme colors from CSS
 */
export function getDefaultDarkColors() {
  if (typeof window === "undefined") return {};

  const root = document.documentElement;
  const colors = {};

  const colorVars = [
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

  // Temporarily add dark class and remove inline styles to get CSS defaults
  const wasDark = root.classList.contains("dark");
  if (!wasDark) {
    root.classList.add("dark");
  }

  const originalStyles = {};
  colorVars.forEach((varName) => {
    const inlineValue = root.style.getPropertyValue(`--${varName}`);
    if (inlineValue) {
      originalStyles[varName] = inlineValue;
      root.style.removeProperty(`--${varName}`);
    }
  });

  const computedStyle = getComputedStyle(root);
  colorVars.forEach((varName) => {
    const value = computedStyle.getPropertyValue(`--${varName}`).trim();
    if (value) {
      colors[varName] = value;
    }
  });

  // Restore inline styles
  Object.entries(originalStyles).forEach(([varName, value]) => {
    root.style.setProperty(`--${varName}`, value);
  });

  // Restore dark class state
  if (!wasDark) {
    root.classList.remove("dark");
  }

  return colors;
}
