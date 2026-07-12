"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { getHelpTopic, resolveHelpTopic } from "@/lib/help/help-registry";

const HelpContext = createContext(null);

function helpIdFromElement(element) {
  if (!(element instanceof Element)) return null;

  const helpElement = element.closest("[data-help-id]");
  const helpId = helpElement?.getAttribute("data-help-id")?.trim();
  return getHelpTopic(helpId) ? helpId : null;
}

export function HelpProvider({ children }) {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [portalContainer, setPortalContainer] = useState(null);
  const [selection, setSelection] = useState({ pathname, helpId: null });

  const activeHelpId =
    selection.pathname === pathname ? selection.helpId : null;
  const topic = useMemo(
    () => resolveHelpTopic({ pathname, helpId: activeHelpId }),
    [activeHelpId, pathname],
  );

  const openHelp = useCallback(
    (helpId) => {
      const requestedHelpId = getHelpTopic(helpId) ? helpId : null;
      const focusedHelpId =
        typeof document === "undefined"
          ? null
          : helpIdFromElement(document.activeElement);

      setSelection({
        pathname,
        helpId: requestedHelpId || focusedHelpId,
      });
      setIsOpen(true);
    },
    [pathname],
  );

  const closeHelp = useCallback(() => setIsOpen(false), []);

  const registerHelpPortalContainer = useCallback((element) => {
    setPortalContainer(element || null);
  }, []);

  const setOpen = useCallback(
    (nextOpen) => {
      if (nextOpen) openHelp();
      else closeHelp();
    },
    [closeHelp, openHelp],
  );

  useEffect(() => {
    const handleHelpShortcut = (event) => {
      if (event.key !== "F1") return;
      event.preventDefault();
      openHelp();
    };

    document.addEventListener("keydown", handleHelpShortcut);
    return () => document.removeEventListener("keydown", handleHelpShortcut);
  }, [openHelp]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleFocusIn = (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-context-help-sheet="true"]')) return;

      setSelection({
        pathname,
        helpId: helpIdFromElement(event.target),
      });
    };

    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [isOpen, pathname]);

  const value = useMemo(
    () => ({
      isOpen,
      activeHelpId,
      topic,
      portalContainer,
      registerHelpPortalContainer,
      openHelp,
      closeHelp,
      setOpen,
    }),
    [
      activeHelpId,
      closeHelp,
      isOpen,
      openHelp,
      portalContainer,
      registerHelpPortalContainer,
      setOpen,
      topic,
    ],
  );

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp() {
  const context = useContext(HelpContext);
  if (!context) {
    throw new Error("useHelp must be used within a HelpProvider");
  }
  return context;
}
