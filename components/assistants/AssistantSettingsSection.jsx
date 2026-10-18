"use client";
import AssistantPostConversationSettings from "./AssistantPostConversationSettings";
import AssistantSectionTabs from "./AssistantSectionTabs";
import AssistantMessagingSettings from "./AssistantMessagingSettings";
import AssistantConfigurationCard from "./AssistantConfigurationCard";
import AssistantSchemaFields from "./AssistantSchemaFields";
import AssistantTranscriptionSettings from "./AssistantTranscriptionSettings";
import { assistantSchemas } from "@/lib/ai/assistant-contract.mjs";
import {
  assistantVoiceSettings,
  withAssistantVoiceSettings,
} from "@/lib/ai/assistant-draft.mjs";
import { useUiText } from "@/components/i18n/use-ui-text";

export const SECTION_TABS = {
  messaging: [
    { id: "routing", label: "Routing & numbers" },
    { id: "delivery", label: "Delivery settings" },
  ],
  voice: [
    { id: "voice", label: "Voice" },
    { id: "transcription", label: "Transcription" },
    { id: "interruptions", label: "Interruptions" },
  ],
  calling: [
    { id: "connection", label: "Connection" },
    { id: "behavior", label: "Call behavior" },
    { id: "recording", label: "Recording" },
    { id: "voicemail", label: "Voicemail" },
  ],
  insights: [
    { id: "insight", label: "Insight group" },
    { id: "processing", label: "Post-conversation" },
  ],
  widget: [
    { id: "appearance", label: "Appearance" },
    { id: "behavior", label: "Behavior & links" },
  ],
  privacy: [
    { id: "retention", label: "Data & retention" },
    { id: "locality", label: "Data locality" },
  ],
};
export function NestedAssistantFields({
  root,
  schemaName,
  fields,
  values,
  setValues,
  alias,
}) {
  const schema = { ...assistantSchemas[schemaName].properties };
  if (root === "voice_settings")
    return (
      <AssistantSchemaFields
        fields={fields}
        schemas={schema}
        requiredFields={assistantSchemas[schemaName].required || []}
        pathPrefix={root}
        values={assistantVoiceSettings(values) || {}}
        originalValues={values._original?.voice_settings}
        setValues={(update) =>
          setValues((previous) =>
            withAssistantVoiceSettings(
              previous,
              update(assistantVoiceSettings(previous) || {}),
            ),
          )
        }
      />
    );
  if (schemaName === "TelephonySettings")
    schema.send_conversation_message_events = {
      type: "boolean",
      description:
        "Existing Contact Center conversation-message event setting. Preserved for previously configured assistants; not listed in the current Telnyx request schema.",
    };
  return (
    <AssistantSchemaFields
      fields={fields}
      schemas={schema}
      requiredFields={assistantSchemas[schemaName].required || []}
      pathPrefix={root}
      values={values[alias || root] || {}}
      originalValues={values._original?.[root]}
      setValues={(update) =>
        setValues((v) => ({
          ...v,
          [alias || root]: update(v[alias || root] || {}),
        }))
      }
    />
  );
}
export default function AssistantSettingsSection({
  section,
  localTab,
  onLocalTabChange,
  values,
  setValues,
  children,
}) {
  const tUi = useUiText();
  return (
    <AssistantSectionTabs
      label={`${section} settings`}
      value={localTab}
      onValueChange={onLocalTabChange}
      tabs={SECTION_TABS[section]}
    >
      {(tab) => {
        if (section === "voice" && tab === "transcription")
          return (
            <AssistantTranscriptionSettings
              value={values.transcription || {}}
              savedValue={values._original?.transcription}
              onChange={(transcription) =>
                setValues((v) => ({ ...v, transcription }))
              }
              availableVariables={Object.keys(values.dynamic_variables || {})}
            />
          );
        if (section === "messaging" && tab === "delivery")
          return (
            <AssistantMessagingSettings values={values} setValues={setValues} />
          );
        if (section === "insights" && tab === "processing")
          return (
            <AssistantPostConversationSettings values={values} setValues={setValues} />
          );
        if (section === "privacy" && tab === "locality")
          return (
            <div className="w-full"><AssistantConfigurationCard title="Regional processing">
              <NestedAssistantFields
                root="privacy_settings"
                schemaName="PrivacySettings"
                fields={["in_transit_data_locality"]}
                values={values}
                setValues={setValues}
              />
              <p className="text-sm text-muted-foreground">
                {tUi(
                  "Applies to web chat only. Use the API hostname for your organization’s data-locality region and Telnyx-hosted models for the primary, fallback and workflow overrides. Voice and messaging are unaffected.",
                )}
              </p>
            </AssistantConfigurationCard></div>
          );
        return (
          <div className="w-full space-y-5 pb-4">
            {children(tab)}

          </div>
        );
      }}
    </AssistantSectionTabs>
  );
}
