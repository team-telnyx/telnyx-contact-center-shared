"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import WidgetAdmin from "@/components/widget-admin/WidgetAdmin";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";

export default function WidgetsPage(){
  const tUi = useUiText();
  return <AdminPageShell><AdminPageHeader title={tUi("Web Widgets")} /><div className="min-h-0 flex-1 overflow-hidden"><WidgetAdmin embedded /></div></AdminPageShell>;
}
