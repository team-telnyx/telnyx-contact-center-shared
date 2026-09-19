"use client";

import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { useTheme } from "next-themes";

// Same picker and category/search configuration as the demo portal SMS composer.
export default function EmojiPickerPanel({onEmojiSelect}) {
  const {resolvedTheme}=useTheme();
  return <div className="w-[300px] max-w-full [&_em-emoji-picker]:w-full [&_em-emoji-picker]:max-w-full [&_em-emoji-picker]:h-[360px] [&_em-emoji-picker]:max-h-[calc(var(--radix-popover-content-available-height)-3rem)]">
    <div className="mb-2 px-2 text-sm font-medium">Emojis</div>
    <Picker data={data} onEmojiSelect={emoji=>onEmojiSelect(emoji.native)}
      previewPosition="none" skinTonePosition="none" navPosition="top" perLine={7}
      dynamicWidth autoFocus theme={resolvedTheme==="dark"?"dark":"light"}/>
  </div>;
}
