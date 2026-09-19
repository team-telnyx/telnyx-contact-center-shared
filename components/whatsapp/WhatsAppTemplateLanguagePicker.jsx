"use client";
import TemplateLanguagePicker from "@/components/messaging/TemplateLanguagePicker";

// Same catalogue as the demo portal and the SMS template builder.
export default function WhatsAppTemplateLanguagePicker({ value, onChange, disabled = false, id = "whatsapp-template-language" }) {
  return <TemplateLanguagePicker id={id} value={value} onChange={onChange} disabled={disabled} data-testid="whatsapp-template-language" />;
}
