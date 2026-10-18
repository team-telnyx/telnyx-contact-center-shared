"use client";
import { useEffect, useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import AssistantConfigurationCard from "./AssistantConfigurationCard";
import { useUiText } from "@/components/i18n/use-ui-text";

export default function AssistantMessagingSettings({ values, setValues }) {
  const tUi = useUiText();
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const value = values.messaging || {};
  useEffect(() => {
    let active = true;
    fetch("/api/messaging/profiles?pageSize=250", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error();
        if (active) setProfiles(data.profiles || []);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);
  function update(patch) {
    setValues((current) => ({
      ...current,
      messaging: { ...current.messaging, ...patch },
    }));
  }
  const options = profiles.map((profile) => ({
    value: profile.id,
    label: profile.name || tUi("Messaging profile"),
  }));
  if (
    value.default_messaging_profile_id &&
    !options.some(
      (option) => option.value === value.default_messaging_profile_id,
    )
  )
    options.unshift({
      value: value.default_messaging_profile_id,
      label: tUi("Saved messaging profile"),
    });
  return (
    <div className="grid w-full items-start gap-5 lg:grid-cols-2">
      <AssistantConfigurationCard
        title="Message delivery"
        description="Choose the profile and destination for delivery updates."
      >
        <div
          className="space-y-2"
          data-setting-path="messaging_settings.default_messaging_profile_id"
        >
          <label
            htmlFor="assistant-messaging-profile"
            className="text-sm font-medium"
          >
            {tUi("Messaging profile")}
          </label>
          {loading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Combobox
              id="assistant-messaging-profile"
              value={value.default_messaging_profile_id || ""}
              options={options}
              onChange={(default_messaging_profile_id) =>
                update({ default_messaging_profile_id })
              }
              triggerClassName="w-full"
              placeholder={tUi("Select messaging profile")}
              emptyLabel={tUi("No messaging profiles available")}
            />
          )}
          {error ? (
            <div role="alert" className="text-sm text-destructive">
              {tUi("Could not load messaging profiles.")}{" "}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLoading(true);
                  setError(false);
                  setReload((n) => n + 1);
                }}
              >
                {tUi("Retry")}
              </Button>
            </div>
          ) : null}
        </div>
        <label
          className="block space-y-2 text-sm"
          data-setting-path="messaging_settings.delivery_status_webhook_url"
        >
          {tUi("Delivery events URL")}
          <Input
            type="url"
            value={value.delivery_status_webhook_url || ""}
            onChange={(e) =>
              update({ delivery_status_webhook_url: e.target.value })
            }
            placeholder="https://example.com/events"
          />
        </label>
        {value.default_messaging_profile_id ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {tUi("Profile details")}
            </summary>
            <p className="mt-2 break-all font-mono">
              {value.default_messaging_profile_id}
            </p>
          </details>
        ) : null}
      </AssistantConfigurationCard>
      <AssistantConfigurationCard
        title="Conversation sessions"
        description="Start a new conversation after a period of inactivity."
        data-setting-path="messaging_settings.conversation_inactivity_minutes"
      >
        <label className="block space-y-2 text-sm">
          {tUi("Inactivity timeout")}
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={1}
              max={10000000}
              required
              aria-invalid={value.conversation_inactivity_minutes === ""}
              aria-describedby={value.conversation_inactivity_minutes === "" ? "messaging-timeout-error" : undefined}
              className="w-32"
              value={value.conversation_inactivity_minutes ?? ""}
              onChange={(e) =>
                update({
                  conversation_inactivity_minutes:
                    e.target.value === "" ? "" : Number(e.target.value),
                })
              }
            />
            <span className="text-xs text-muted-foreground">
              {tUi("minutes")}
            </span>
          </div>
          {value.conversation_inactivity_minutes === "" && <p id="messaging-timeout-error" className="text-xs text-destructive">{tUi("Enter a timeout between 1 and 10,000,000 minutes.")}</p>}
        </label>
      </AssistantConfigurationCard>
    </div>
  );
}
