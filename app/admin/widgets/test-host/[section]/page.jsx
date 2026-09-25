import { notFound } from "next/navigation";
import WidgetTestHostPage from "@/components/widget-admin/WidgetTestHostPage";

const sections = new Set(["products", "checkout", "support", "account"]);

export default async function Page({ params, searchParams }) {
  const { section } = await params;
  if (!sections.has(section)) notFound();
  const { widget = "" } = await searchParams;
  return <WidgetTestHostPage initialSection={section} widgetId={widget} />;
}
