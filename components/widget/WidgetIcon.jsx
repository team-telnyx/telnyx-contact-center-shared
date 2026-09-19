import { MessageCircle } from "lucide-react";
import { normalizeWidgetIconId } from "@/lib/widgets/icon-catalog";
import { WIDGET_ICON_COMPONENTS } from "@/lib/widgets/icon-components";

export default function WidgetIcon({ name, fallback = "message-circle", ...props }) {
  const Icon = WIDGET_ICON_COMPONENTS[normalizeWidgetIconId(name, fallback)] || MessageCircle;
  return <Icon {...props} />;
}
