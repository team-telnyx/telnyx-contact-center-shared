"use client";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Skeleton } from "@/components/ui/skeleton";

export default function EmojiPickerLoading() {
  const tUi = useUiText();
  return <div role="status" aria-label={tUi("Loading emojis")} className="w-[300px] max-w-full space-y-3 p-2">
    <Skeleton className="h-6 w-24" />
    <Skeleton className="h-9 w-full" />
    <Skeleton className="h-64 w-full" />
  </div>;
}
