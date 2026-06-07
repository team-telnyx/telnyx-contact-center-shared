/**
 * Server-side color utilities for OKLCH to hex conversion
 * These functions work in Node.js environment (no browser APIs)
 */

import { platformApiLogger, runtimePayload } from "./runtime-logging.mjs";

/**
 * Convert OKLCH to RGB (server-side implementation)
 * @param {string} oklchString - OKLCH string like "oklch(81.25% 0.167 166.68)" or "oklch(1 0 0)"
 * @returns {Object} {r, g, b} values 0-255 or null if invalid
 */
export function oklchToRgb(oklchString) {
  if (!oklchString || typeof oklchString !== "string") return null;

  try {
    // Parse OKLCH string
    // Format: oklch(L% C H) or oklch(L C H) or oklch(L% C H / alpha)
    // Lightness can be 0-1 (decimal) or 0-100% (percentage)
    const match = oklchString.match(
      /oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%)?)?\s*\)/
    );
    if (!match) return null;

    const lightnessValue = parseFloat(match[1]);
    const isPercentage = match[2] === "%";
    const L = isPercentage ? lightnessValue / 100 : lightnessValue; // Convert to 0-1 range
    const C = parseFloat(match[3]);
    const H = parseFloat(match[4]) * (Math.PI / 180); // Convert degrees to radians

    // Convert OKLCH to OKLab
    const a_ok = C * Math.cos(H);
    const b_ok = C * Math.sin(H);

    // Convert OKLab to linear RGB
    const l_ = L + 0.3963377774 * a_ok + 0.2158037573 * b_ok;
    const m_ = L - 0.1055613458 * a_ok - 0.0638541728 * b_ok;
    const s_ = L - 0.0894841775 * a_ok - 1.291485548 * b_ok;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    // Convert LMS to linear RGB
    const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

    // Convert linear RGB to sRGB
    const toSRGB = (c) => {
      if (c <= 0.0031308) {
        return 12.92 * c;
      }
      return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    };

    const r = toSRGB(rLin);
    const g = toSRGB(gLin);
    const b = toSRGB(bLin);

    // Clamp to 0-1 and convert to 0-255
    const r255 = Math.round(Math.max(0, Math.min(1, r)) * 255);
    const g255 = Math.round(Math.max(0, Math.min(1, g)) * 255);
    const b255 = Math.round(Math.max(0, Math.min(1, b)) * 255);

    return { r: r255, g: g255, b: b255 };
  } catch (error) {
    platformApiLogger.warn("oklch_to_rgb_failed", runtimePayload({ error, operation: "oklch_to_rgb" }));
    return null;
  }
}

/**
 * Convert RGB to hex
 * @param {number} r - Red 0-255
 * @param {number} g - Green 0-255
 * @param {number} b - Blue 0-255
 * @returns {string} Hex color like "#ffffff"
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
 * Convert OKLCH to hex
 * @param {string} oklchString - OKLCH string
 * @returns {string} Hex color or null if invalid
 */
export function oklchToHex(oklchString) {
  const rgb = oklchToRgb(oklchString);
  if (!rgb) return null;
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}
