"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { oklchToRgb, rgbToOklch, rgbToHex, hexToRgb } from "@/lib/color-utils";
import { cn } from "@/lib/utils";

// Helper function to convert OKLCH to hex (can be called outside component)
function convertOklchToHexSync(oklchStr) {
  if (!oklchStr || !oklchStr.trim()) return null;
  if (typeof window === "undefined" || !document.body) return null;

  try {
    const rgb = oklchToRgb(oklchStr);
    if (
      rgb &&
      typeof rgb.r === "number" &&
      typeof rgb.g === "number" &&
      typeof rgb.b === "number" &&
      rgb.r >= 0 &&
      rgb.r <= 255 &&
      rgb.g >= 0 &&
      rgb.g <= 255 &&
      rgb.b >= 0 &&
      rgb.b <= 255
    ) {
      return rgbToHex(rgb.r, rgb.g, rgb.b);
    }
  } catch (e) {
    console.error("Error converting OKLCH to hex:", e, oklchStr);
  }
  return null;
}

export function ColorPicker({ value, onChange, label, className }) {
  const [hexValue, setHexValue] = useState("#000000");
  const [oklchValue, setOklchValue] = useState(value || "");

  // Convert OKLCH to hex helper
  const convertOklchToHex = useCallback((oklchStr) => {
    return convertOklchToHexSync(oklchStr);
  }, []);

  // Get preview color from OKLCH value - convert to hex for color input
  const getPreviewColor = useCallback(() => {
    if (oklchValue) {
      const hex = convertOklchToHex(oklchValue);
      if (hex) return hex;
    }
    return hexValue || "#000000";
  }, [oklchValue, hexValue, convertOklchToHex]);

  // Effect to sync hex value when value prop changes
  useEffect(() => {
    if (value && value.trim()) {
      setOklchValue(value);

      // Function to attempt conversion with retries
      const attemptConversion = (retryCount = 0) => {
        if (typeof window === "undefined" || !document.body) {
          // DOM not ready, wait and retry
          if (retryCount < 20) {
            setTimeout(() => attemptConversion(retryCount + 1), 50);
          }
          return;
        }

        const hex = convertOklchToHex(value);
        if (hex) {
          setHexValue(hex);
        } else if (retryCount < 5) {
          // Retry a few times if conversion fails
          setTimeout(
            () => attemptConversion(retryCount + 1),
            100 * (retryCount + 1)
          );
        }
      };

      // Try immediate conversion
      if (typeof window !== "undefined" && document.body) {
        const immediateHex = convertOklchToHex(value);
        if (immediateHex) {
          setHexValue(immediateHex);
        } else {
          // If immediate fails, try with requestAnimationFrame
          requestAnimationFrame(() => {
            attemptConversion(0);
          });
        }
      } else {
        // DOM not ready, start retry loop
        attemptConversion(0);
      }
    } else {
      setOklchValue("");
      setHexValue("#000000");
    }
  }, [value, convertOklchToHex]);

  const handleHexChange = (e) => {
    const hex = e.target.value;
    setHexValue(hex);
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      const rgb = hexToRgb(hex);
      if (rgb) {
        const oklch = rgbToOklch(rgb.r, rgb.g, rgb.b, oklchValue);
        setOklchValue(oklch);
        onChange?.(oklch);
      }
    }
  };

  const handleOklchChange = (e) => {
    const newValue = e.target.value;
    setOklchValue(newValue);
    try {
      const rgb = oklchToRgb(newValue);
      if (
        rgb &&
        typeof rgb.r === "number" &&
        typeof rgb.g === "number" &&
        typeof rgb.b === "number"
      ) {
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
        setHexValue(hex);
        onChange?.(newValue);
      }
    } catch (e) {
      // Invalid OKLCH, but allow typing
    }
  };

  const previewColor = getPreviewColor();

  return (
    <div className={cn("space-y-2", className)}>
      {label && <Label className="text-sm font-medium">{label}</Label>}
      <div className="flex items-center gap-2">
        <div className="relative">
          {/* Preview square showing the actual color */}
          {/* Modern browsers support OKLCH directly in CSS */}
          <div
            className="h-10 w-16 rounded-md border border-input cursor-pointer flex-shrink-0"
            style={{
              backgroundColor: oklchValue || previewColor || "#000000",
            }}
          />
          {/* Native color input overlay for picking colors */}
          {/* The value prop ensures the picker shows the current color position */}
          <input
            type="color"
            value={previewColor}
            onChange={(e) => {
              const hex = e.target.value;
              setHexValue(hex);
              const rgb = hexToRgb(hex);
              if (rgb) {
                // Use accurate conversion without original OKLCH to get exact color
                const oklch = rgbToOklch(rgb.r, rgb.g, rgb.b, null);
                setOklchValue(oklch);
                // Trigger onChange immediately to apply the color
                onChange?.(oklch);
              }
            }}
            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
          />
        </div>
        <div className="flex-1 space-y-1">
          <Input
            type="text"
            value={hexValue}
            onChange={handleHexChange}
            placeholder="#000000"
            className="font-mono text-sm"
          />
          <Input
            type="text"
            value={oklchValue}
            onChange={handleOklchChange}
            placeholder="oklch(...)"
            className="font-mono text-xs"
          />
        </div>
      </div>
    </div>
  );
}
