"use client";

import Image from "next/image";
import { useAppSettings } from "@/hooks/use-app-settings";

export function SidebarLogo() {
  const { sidebarLogoUri, loading } = useAppSettings();

  if (loading) {
    return (
      <Image
        src="/sidebar_logo.png"
        alt="Brand Logo"
        width={250}
        height={50}
        priority
        style={{ width: "auto", height: "auto" }}
        className="brightness-0 dark:brightness-100"
      />
    );
  }

  if (sidebarLogoUri) {
    return (
      <img
        src={sidebarLogoUri}
        alt="Brand Logo"
        style={{ width: "auto", height: "auto", maxHeight: "50px" }}
        className="brightness-0 dark:brightness-100"
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
      style={{ width: "auto", height: "auto" }}
      className="brightness-0 dark:brightness-100"
    />
  );
}
