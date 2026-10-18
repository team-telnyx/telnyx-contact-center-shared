"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


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
  const tUi = useUiText();
  const { resolvedTheme, theme, setTheme } = useTheme();
  const activeTheme = themeLabels[theme] || themeLabels.system;
  const ThemeIcon = resolvedTheme === "dark" ? IconMoon : IconSun;

  return (
    <header className="help-topbar">
      <Link href="/help" className="help-brand" aria-label={tUi("Telnyx Contact Center Docs")}>
        <Image
          src="/sidebar_logo.png"
          alt={tUi("Telnyx")}
          width={112}
          height={30}
          priority
          className="h-7 w-auto"
        />
        <span className="help-brand-divider" />
        <span className="help-brand-title">{tUi("Docs")}</span>
      </Link>

      <nav className="help-topbar-actions" aria-label={tUi("Documentation actions")}>
        <Button asChild variant="ghost" size="sm" className="help-topbar-link">
          <Link href="/">
            <IconLayoutDashboard className="size-4" />{tUi("Application")}</Link>
        </Button>
        <Button asChild variant="ghost" size="sm" className="help-topbar-link">
          <Link href="/help/changelog">
            <IconHistory className="size-4" />{tUi("Changelog")}</Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" className="help-theme-trigger">
              <ThemeIcon className="size-4" />
              {tUi(activeTheme)}
              <IconChevronDown className="size-3.5 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <IconSun className="size-4" />{tUi("Light")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <IconMoon className="size-4" />{tUi("Dark")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <ThemeIcon className="size-4" />{tUi("System")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </header>
  );
}
