import WidgetTestHostPage from "@/components/widget-admin/WidgetTestHostPage";

export default async function Page({ searchParams }) {
  const { widget = "" } = await searchParams;
  return <WidgetTestHostPage initialSection="overview" widgetId={widget} />;
}
