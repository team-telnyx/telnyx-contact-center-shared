"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


export default function DTMFToolEditor() {
  const tUi = useUiText();
  return (
    <div className="text-xs text-muted-foreground">{tUi("No configuration required.")}</div>
  );
}
