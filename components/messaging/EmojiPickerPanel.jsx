"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import en from "@emoji-mart/data/i18n/en.json";
import de from "@emoji-mart/data/i18n/de.json";
import nl from "@emoji-mart/data/i18n/nl.json";
import es from "@emoji-mart/data/i18n/es.json";
import fr from "@emoji-mart/data/i18n/fr.json";
import pt from "@/messages/emoji-pt-PT.json";
import it from "@emoji-mart/data/i18n/it.json";
import pl from "@emoji-mart/data/i18n/pl.json";
const pickerLanguages = {en, de, nl, es, fr, pt, it, pl};

import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { useTheme } from "next-themes";

// Same picker and category/search configuration as the demo portal SMS composer.
export default function EmojiPickerPanel({onEmojiSelect}) {
  const tUi = useUiText();
  const {resolvedTheme}=useTheme();
  return <div className="w-[300px] max-w-full [&_em-emoji-picker]:w-full [&_em-emoji-picker]:max-w-full [&_em-emoji-picker]:h-[360px] [&_em-emoji-picker]:max-h-[calc(var(--radix-popover-content-available-height)-3rem)]">
    <div className="mb-2 px-2 text-sm font-medium">{tUi("Emojis")}</div>
    {/* Emoji Mart initializes its dictionary at mount; updating i18n alone leaves stale copy. */}
    <Picker key={tUi.locale} data={data} locale={tUi.locale.split("-")[0]} i18n={pickerLanguages[tUi.locale.split("-")[0]] || en} onEmojiSelect={emoji=>onEmojiSelect(emoji.native)}
      previewPosition="none" skinTonePosition="none" navPosition="top" perLine={7}
      dynamicWidth autoFocus theme={resolvedTheme==="dark"?"dark":"light"}/>
  </div>;
}
