"use client";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { TEMPLATE_LANGUAGES, templateLanguage } from "@/lib/messaging/template-languages.mjs";

// Flag, name and language code, filterable by name or code. Shared by the
// WhatsApp and SMS template builders so a workspace sees one catalogue.
export default function TemplateLanguagePicker({ value, onChange, disabled = false, id = "template-language", heading = "Template languages", ...rest }) {
  const options = TEMPLATE_LANGUAGES.map((language) => ({ value: language.code, label: language.name, description: language.code, flag: language.flag }));
  // A code stored before the picker (or from another provider) stays selectable.
  if (value && !templateLanguage(value)) options.unshift({ value, label: value, description: value, flag: "🌐" });
  return <SearchableSelect id={id} value={templateLanguage(value)?.code || value} onChange={onChange} options={options} disabled={disabled}
    placeholder="Select language" searchPlaceholder="Filter languages…" emptyText="No language found." heading={heading} aria-label="Language" {...rest} />;
}
