"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";

/**
 * An input for a value that is normalized on its way back to the field.
 *
 * The messaging settings card and the campaign panel both re-derive their form
 * from `normalizeMessagingSettings` / `normalizeMessagingCampaignConfig` on
 * every render. Those normalizers trim and clamp, so they rewrite the value
 * between one keystroke and the next: the space just typed is trailing
 * whitespace and disappeared, making a multi-word "From name" or subject line
 * impossible to enter, and a cleared number field jumped straight back to its
 * minimum instead of waiting for the number being typed.
 *
 * While the operator is typing, the field shows exactly what they typed. Once
 * they leave it, the normalized value is shown again, so the field always ends
 * up displaying what is stored. `parse` converts the raw text for the caller,
 * e.g. to a number.
 */
export default function DraftTextInput({ value = "", onChange, parse = null, onBlur, ...props }) {
  // null means "not being edited": the normalized value is displayed as is.
  const [draft, setDraft] = useState(null);
  return <Input
    {...props}
    value={draft === null ? value ?? "" : draft}
    onBlur={(event) => { setDraft(null); onBlur?.(event); }}
    onChange={(event) => { setDraft(event.target.value); onChange?.(parse ? parse(event.target.value) : event.target.value); }}
  />;
}
