"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { Switch } from "@/components/ui/switch";
import AssistantConfigurationCard from "./AssistantConfigurationCard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconAlertTriangle,
  IconShield,
  IconShieldCheck,
  IconInfoCircle,
} from "@tabler/icons-react";

export default function PrivacyTab({ values, setValues }) {
  const tUi = useUiText();
  const privacy = values?.privacy_settings || {};
  const dataRetention = Boolean(privacy?.data_retention);
  const piiRedaction = String(privacy?.pii_redaction || "disabled");
  const isPiiRedactionEnabled = ["enabled", "redact"].includes(piiRedaction);

  function setDataRetention(val) {
    setValues((v) => ({
      ...v,
      privacy_settings: {
        ...(v.privacy_settings || {}),
        data_retention: Boolean(val),
      },
    }));
  }

  function setPiiRedaction(mode) {
    setValues((v) => ({
      ...v,
      privacy_settings: {
        ...(v.privacy_settings || {}),
        pii_redaction: mode,
      },
    }));
  }

  const isRetain = dataRetention;

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <AssistantConfigurationCard title="Conversation history retention" data-setting-path="privacy_settings.data_retention">
          <label className="flex items-center justify-between gap-4 text-sm">{tUi("Store conversation history and insights")}<Switch checked={isRetain} onCheckedChange={setDataRetention} /></label>
          <Alert variant={isRetain ? "warning" : "success"}>
            {isRetain ? (
              <IconAlertTriangle className="h-4 w-4" />
            ) : (
              <IconShieldCheck className="h-4 w-4" />
            )}
            <AlertDescription>
              <div className="font-medium mb-1">
                {isRetain
                  ? tUi("Conversation history and insights will be stored.")
                  : tUi("Conversation history and insights will not be stored.")}
              </div>
              <div className="text-xs opacity-90">{tUi("This in-tool toggle governs solely the retention of conversation history and insights via the AI assistant. It has no effect on any separate recording, transcription, or storage configuration that you have set at the account, number, or application level. All such external settings remain in force regardless of your selection here.")}</div>
            </AlertDescription>
          </Alert>
        </AssistantConfigurationCard>
        <AssistantConfigurationCard title="Personal information" data-setting-path="privacy_settings.pii_redaction">
          <label className="flex items-center justify-between gap-4 text-sm">{tUi("Redact personal information")}<Switch checked={isPiiRedactionEnabled} onCheckedChange={enabled => setPiiRedaction(enabled ? "enabled" : "disabled")} /></label>
          <Alert variant={isPiiRedactionEnabled ? "success" : "info"}>
            {isPiiRedactionEnabled ? (
              <IconShield className="h-4 w-4" />
            ) : (
              <IconInfoCircle className="h-4 w-4" />
            )}
            <AlertDescription>
              <div className="font-medium mb-1">
                {isPiiRedactionEnabled
                  ? tUi("PII redaction is enabled - sensitive data will be replaced with PII tags.")
                  : tUi("PII redaction is disabled - sensitive data may be stored as-is.")}
              </div>
              <div className="text-xs opacity-90">{tUi("When enabled, the assistant conversation history uses a language model to replace personally identifiable information with empty tags such as ")}<code>{"<PII:email_address/>"}</code>{tUi(". This setting applies to AI assistant conversation history; it does not redact external recordings, metadata, webhooks, or storage configured outside the assistant.")}</div>
            </AlertDescription>
          </Alert>
        </AssistantConfigurationCard>
      </div>
    </div>
  );
}
