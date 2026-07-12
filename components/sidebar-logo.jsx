"use client";

import Image from "next/image";
import { useAppSettings } from "@/hooks/use-app-settings";
import { cn } from "@/lib/utils";

export function SidebarLogo({ className }) {
  const { sidebarLogoUri, loading } = useAppSettings();
  const logoClassName = cn(
    "block h-auto max-h-full w-auto max-w-full object-contain brightness-0 dark:brightness-100",
    className,
  );

  if (loading) {
    return (
      <Image
        src="/sidebar_logo.png"
        alt="Brand Logo"
        width={250}
        height={50}
        priority
        className={logoClassName}
      />
    );
  }

  if (sidebarLogoUri) {
    return (
      <img
        src={sidebarLogoUri}
        alt="Brand Logo"
        className={logoClassName}
      />
    );
  }

  return (
    <Image
      src="/sidebar_logo.png"
      alt="Brand Logo"
      width={250}
      height={50}
      priority
      className={logoClassName}
    />
  );
}
