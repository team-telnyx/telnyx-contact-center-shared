"use client";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconAlertTriangle,
  IconShield,
  IconShieldCheck,
  IconInfoCircle,
} from "@tabler/icons-react";

export default function PrivacyTab({ values, setValues }) {
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-2">
          <div className="text-sm font-medium">
            Conversation History Retention
          </div>
          <div className="inline-flex gap-2">
            <Button
              size="sm"
              variant={isRetain ? "default" : "secondary"}
              onClick={() => setDataRetention(true)}
            >
              Retain
            </Button>
            <Button
              size="sm"
              variant={!isRetain ? "default" : "secondary"}
              onClick={() => setDataRetention(false)}
            >
              Do Not Retain
            </Button>
          </div>
          <Alert variant={isRetain ? "warning" : "success"}>
            {isRetain ? (
              <IconAlertTriangle className="h-4 w-4" />
            ) : (
              <IconShieldCheck className="h-4 w-4" />
            )}
            <AlertDescription>
              <div className="font-medium mb-1">
                {isRetain
                  ? "Conversation history and insights will be stored."
                  : "Conversation history and insights will not be stored."}
              </div>
              <div className="text-xs opacity-90">
                This in-tool toggle governs solely the retention of conversation
                history and insights via the AI assistant. It has no effect on
                any separate recording, transcription, or storage configuration
                that you have set at the account, number, or application level.
                All such external settings remain in force regardless of your
                selection here.
              </div>
            </AlertDescription>
          </Alert>
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">PII Data Redaction</div>
          <div className="inline-flex gap-2">
            <Button
              size="sm"
              variant={isPiiRedactionEnabled ? "default" : "secondary"}
              onClick={() => setPiiRedaction("enabled")}
            >
              Redact
            </Button>
            <Button
              size="sm"
              variant={!isPiiRedactionEnabled ? "default" : "secondary"}
              onClick={() => setPiiRedaction("disabled")}
            >
              Disabled
            </Button>
          </div>
          <Alert variant={isPiiRedactionEnabled ? "success" : "info"}>
            {isPiiRedactionEnabled ? (
              <IconShield className="h-4 w-4" />
            ) : (
              <IconInfoCircle className="h-4 w-4" />
            )}
            <AlertDescription>
              <div className="font-medium mb-1">
                {isPiiRedactionEnabled
                  ? "PII redaction is enabled - sensitive data will be replaced with PII tags."
                  : "PII redaction is disabled - sensitive data may be stored as-is."}
              </div>
              <div className="text-xs opacity-90">
                When enabled, the assistant conversation history uses a language
                model to replace personally identifiable information with empty
                tags such as <code>{"<PII:email_address/>"}</code>. This setting
                applies to AI assistant conversation history; it does not redact
                external recordings, metadata, webhooks, or storage configured
                outside the assistant.
              </div>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    </div>
  );
}
