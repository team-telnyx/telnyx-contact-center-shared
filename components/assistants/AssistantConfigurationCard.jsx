"use client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useUiText } from "@/components/i18n/use-ui-text";
import { cn } from "@/lib/utils";

export default function AssistantConfigurationCard({
  title,
  description,
  children,
  className,
  ...props
}) {
  const tUi = useUiText();
  return (
    <Card className={cn("min-w-0 rounded-xl", className)} {...props}>
      <CardHeader className="p-5 pb-4">
        <CardTitle className="text-base">{tUi(title)}</CardTitle>
        {description ? (
          <CardDescription className="text-xs leading-relaxed">
            {tUi(description)}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4 p-5 pt-0">{children}</CardContent>
    </Card>
  );
}
