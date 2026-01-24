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
import { setupSessionMonitor } from "@/lib/session-monitor";

export default function PortalLayout({ children }) {
  useThemeColors();

  useEffect(() => {
    // Set up session monitoring for automatic offline detection
    const cleanup = setupSessionMonitor();
    return cleanup;
  }, []);

  return (
    <SidebarProvider
      className="flex flex-1 h-full"
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
          </ContactCenterStreamProvider>
        </PhoneUiProvider>
      </TelephonyProvider>
    </SidebarProvider>
  );
}
