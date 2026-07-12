"use client";

import Image from "next/image";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  IconChevronDown,
  IconHistory,
  IconLayoutDashboard,
  IconMoon,
  IconSun,
} from "@tabler/icons-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const themeLabels = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function DocsTopBar() {
  const { resolvedTheme, theme, setTheme } = useTheme();
  const activeTheme = themeLabels[theme] || themeLabels.system;
  const ThemeIcon = resolvedTheme === "dark" ? IconMoon : IconSun;

  return (
    <header className="help-topbar">
      <Link href="/help" className="help-brand" aria-label="Telnyx Contact Center Docs">
        <Image
          src="/sidebar_logo.png"
          alt="Telnyx"
          width={112}
          height={30}
          priority
          className="h-7 w-auto"
        />
        <span className="help-brand-divider" />
        <span className="help-brand-title">Docs</span>
      </Link>

      <nav className="help-topbar-actions" aria-label="Documentation actions">
        <Button asChild variant="ghost" size="sm" className="help-topbar-link">
          <Link href="/">
            <IconLayoutDashboard className="size-4" />
            Application
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm" className="help-topbar-link">
          <Link href="/help/changelog">
            <IconHistory className="size-4" />
            Changelog
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" className="help-theme-trigger">
              <ThemeIcon className="size-4" />
              {activeTheme}
              <IconChevronDown className="size-3.5 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <IconSun className="size-4" />
              Light
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <IconMoon className="size-4" />
              Dark
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <ThemeIcon className="size-4" />
              System
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </header>
  );
}
