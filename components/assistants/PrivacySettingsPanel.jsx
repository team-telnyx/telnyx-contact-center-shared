"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { IconAlertTriangle, IconShield, IconShieldCheck } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function PrivacySettingsPanel({ values, setValues }) {
  const tUi = useUiText();
  const privacy = values.privacy_settings || {};
  const retain = Boolean(privacy.data_retention);
  const redact = ["enabled", "redact"].includes(String(privacy.pii_redaction || "disabled"));
  function patch(next) { setValues((current) => ({ ...current, privacy_settings: { ...(current.privacy_settings || {}), ...next } })); }
  return <Card><CardHeader><CardTitle>{tUi("Privacy")}</CardTitle><CardDescription>{tUi("Control assistant conversation retention and PII redaction.")}</CardDescription></CardHeader><CardContent className="grid gap-5 xl:grid-cols-2">
    <div className="space-y-3"><div className="font-medium">{tUi("Conversation history retention")}</div><div className="flex gap-2"><Button variant={retain ? "default" : "outline"} onClick={() => patch({ data_retention: true })}>{tUi("Retain")}</Button><Button variant={!retain ? "default" : "outline"} onClick={() => patch({ data_retention: false })}>{tUi("Do not retain")}</Button></div><Alert variant={retain ? "warning" : "success"}>{retain ? <IconAlertTriangle className="size-4" /> : <IconShieldCheck className="size-4" />}<AlertDescription>{retain ? tUi("Conversation history and insights will be stored.") : tUi("Assistant conversation history and insights will not be retained.")}</AlertDescription></Alert></div>
    <div className="space-y-3"><div className="font-medium">{tUi("PII data redaction")}</div><div className="flex gap-2"><Button variant={redact ? "default" : "outline"} onClick={() => patch({ pii_redaction: "enabled" })}>{tUi("Redact")}</Button><Button variant={!redact ? "default" : "outline"} onClick={() => patch({ pii_redaction: "disabled" })}>{tUi("Disabled")}</Button></div><Alert variant={redact ? "success" : "default"}>{redact ? <IconShield className="size-4" /> : <IconAlertTriangle className="size-4" />}<AlertDescription>{redact ? tUi("Sensitive values in assistant history will be replaced with PII tags.") : tUi("Sensitive values may be retained in assistant conversation history.")}</AlertDescription></Alert></div>
  </CardContent></Card>;
}
