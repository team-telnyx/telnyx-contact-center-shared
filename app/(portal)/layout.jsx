"use client";

import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useThemeColors } from "@/hooks/use-theme-colors";
import { TelephonyProvider } from "@/components/telephony-provider";
import { PhoneUiProvider } from "@/components/phone-ui-provider";
import FloatingSoftphone from "@/components/floating-softphone";
import { ContactCenterStreamProvider } from "@/components/contact-center/ContactCenterStreamProvider";
import { GlobalWrapupSheet } from "@/components/contact-center/GlobalWrapupSheet";
import { setupSessionMonitor } from "@/lib/session-monitor";
import { HelpProvider } from "@/components/help/HelpProvider";
import { ContextHelpSheet } from "@/components/help/ContextHelpSheet";

export default function PortalLayout({ children }) {
  useThemeColors();

  useEffect(() => {
    // Set up session monitoring for automatic offline detection
    const cleanup = setupSessionMonitor();
    return cleanup;
  }, []);

  return (
    <HelpProvider>
      <SidebarProvider
        className="flex h-full flex-1"
        style={{
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        }}
      >
        <TelephonyProvider>
          <PhoneUiProvider>
            <ContactCenterStreamProvider>
              <AppSidebar variant="inset" />
              <SidebarInset className="flex flex-col overflow-hidden">
                <SiteHeader />
                <div className="flex flex-1 flex-col overflow-auto">
                  <div className="@container/main flex flex-1 flex-col">
                    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
                      {children}
                    </div>
                  </div>
                </div>
              </SidebarInset>
              <FloatingSoftphone />
              <GlobalWrapupSheet />
            </ContactCenterStreamProvider>
          </PhoneUiProvider>
        </TelephonyProvider>
        <ContextHelpSheet />
      </SidebarProvider>
    </HelpProvider>
  );
}
