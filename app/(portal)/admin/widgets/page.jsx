"use client";

import WidgetAdmin from "@/components/widget-admin/WidgetAdmin";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";

export default function WidgetsPage(){
  return <AdminPageShell><AdminPageHeader title="Web Widgets" /><div className="min-h-0 flex-1 overflow-hidden"><WidgetAdmin embedded /></div></AdminPageShell>;
}
