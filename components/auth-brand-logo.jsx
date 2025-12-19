"use client";

import Image from "next/image";
import { useAppSettings } from "@/hooks/use-app-settings";

export function AuthBrandLogo() {
  const { brandLogoUri, loading } = useAppSettings();

  if (loading) {
    return (
      <Image
        src="/auth_brand_logo.png"
        alt="Brand Logo"
        width={400}
        height={50}
        style={{ width: "auto", height: "auto" }}
        priority
        className="brightness-0 dark:invert"
      />
    );
  }

  if (brandLogoUri) {
    return (
      <img
        src={brandLogoUri}
        alt="Brand Logo"
        style={{ width: "auto", height: "auto", maxHeight: "50px" }}
        className="brightness-0 dark:invert"
      />
    );
  }

  return (
    <Image
      src="/auth_brand_logo.png"
      alt="Brand Logo"
      width={400}
      height={50}
      style={{ width: "auto", height: "auto" }}
      priority
      className="brightness-0 dark:invert"
    />
  );
}
