"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import AssistantConfigurationCard from "./AssistantConfigurationCard";
import { IntegrationSecretField } from "./AssistantModelConfiguration";
import { SchemaValue } from "./AssistantSchemaFields";
import { assistantSchemas } from "@/lib/ai/assistant-contract.mjs";
import { useUiText } from "@/components/i18n/use-ui-text";

function TextField({ label, value, onChange, type = "text", ...props }) {
  const tUi = useUiText();
  return (
    <label className="block space-y-2 text-sm">
      <span>{tUi(label)}</span>
      <Input
        type={type}
        value={value ?? ""}
        onChange={(e) =>
          onChange(
            type === "number"
              ? e.target.value === ""
                ? undefined
                : Number(e.target.value)
              : e.target.value,
          )
        }
        {...props}
      />
    </label>
  );
}

export function AssistantObservabilitySettings({ values, setValues }) {
  const tUi = useUiText();
  const observability = values.observability_settings || {};
  const socket = values.websocket_settings || {};
  function update(root, patch) {
    setValues((current) => ({
      ...current,
      [root]: { ...current[root], ...patch },
    }));
  }
  const setObservability = (patch) => update("observability_settings", patch);
  const setSocket = (patch) => update("websocket_settings", patch);
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <AssistantConfigurationCard
        title="Conversation observability"
        description="Send traces to Langfuse and optionally synchronize a managed prompt."
        data-setting-path="observability_settings"
      >
        <label className="flex items-center justify-between gap-4 text-sm font-medium">
          {tUi("Enable observability")}
          <Switch
            checked={observability.status === "enabled"}
            onCheckedChange={(enabled) =>
              setObservability({ status: enabled ? "enabled" : "disabled" })
            }
          />
        </label>
        {observability.status === "enabled" ? (
          <>
            <TextField
              label="Langfuse host"
              type="url"
              value={observability.host}
              onChange={(host) => setObservability({ host })}
              placeholder="https://cloud.langfuse.com"
            />
            <IntegrationSecretField
              label="Public key secret"
              value={observability.public_key_ref}
              onChange={(public_key_ref) =>
                setObservability({ public_key_ref })
              }
            />
            <IntegrationSecretField
              label="Private key secret"
              value={observability.secret_key_ref}
              onChange={(secret_key_ref) =>
                setObservability({ secret_key_ref })
              }
            />
            <div className="space-y-4 border-t pt-4">
              <label className="flex items-center justify-between gap-4 text-sm font-medium">
                {tUi("Sync prompt changes")}
                <Switch
                  checked={observability.prompt_sync === "enabled"}
                  onCheckedChange={(enabled) =>
                    setObservability({
                      prompt_sync: enabled ? "enabled" : "disabled",
                    })
                  }
                />
              </label>
              <TextField
                label="Prompt name"
                value={observability.prompt_name}
                onChange={(prompt_name) => setObservability({ prompt_name })}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Prompt label"
                  value={observability.prompt_label}
                  onChange={(prompt_label) =>
                    setObservability({ prompt_label })
                  }
                />
                <TextField
                  label="Prompt version"
                  type="number"
                  min={1}
                  className="max-w-36"
                  value={observability.prompt_version}
                  onChange={(prompt_version) =>
                    setObservability({ prompt_version })
                  }
                />
              </div>
            </div>
          </>
        ) : null}
      </AssistantConfigurationCard>
      <AssistantConfigurationCard
        title="Live event connection"
        description="Stream conversation events to your server over WebSocket."
        data-setting-path="websocket_settings"
      >
        <label className="flex items-center justify-between gap-4 text-sm font-medium">
          {tUi("Enable event connection")}
          <Switch
            checked={Boolean(socket.enabled)}
            onCheckedChange={(enabled) => setSocket({ enabled })}
          />
        </label>
        {socket.enabled ? (
          <>
            <TextField
              label="WebSocket URL"
              value={socket.url}
              onChange={(url) => setSocket({ url })}
              placeholder="wss://example.com/events"
            />
            <IntegrationSecretField
              label="Authentication secret"
              value={socket.auth_ref}
              onChange={(auth_ref) => setSocket({ auth_ref })}
            />
          </>
        ) : null}
      </AssistantConfigurationCard>
    </div>
  );
}

export function AssistantA2ASettings({ values, setValues }) {
  const tUi = useUiText();
  const agents = values.a2a_agents || [];
  function update(index, patch) {
    setValues((current) => ({
      ...current,
      a2a_agents: current.a2a_agents.map((agent, i) =>
        i === index ? { ...agent, ...patch } : agent,
      ),
    }));
  }
  return (
    <div className="space-y-5" data-setting-path="a2a_agents">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{tUi("Connected agents")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {tUi("Connect specialized agents using their A2A endpoint.")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setValues((current) => ({
              ...current,
              a2a_agents: [
                ...(current.a2a_agents || []),
                { name: "", url: "", async: false },
              ],
            }))
          }
        >
          <IconPlus className="size-4" />
          {tUi("Add agent")}
        </Button>
      </div>
      {!agents.length ? (
        <div className="w-full rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          {tUi(
            "No connected agents. Add an agent to configure its connection and response behavior.",
          )}
        </div>
      ) : null}
      {agents.map((agent, index) => (
        <section key={index} className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              {agent.name || tUi("Agent {value0}", { value0: index + 1 })}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={tUi("Remove agent")}
              onClick={() =>
                setValues((current) => ({
                  ...current,
                  a2a_agents: current.a2a_agents.filter((_, i) => i !== index),
                }))
              }
            >
              <IconTrash className="size-4" />
            </Button>
          </div>
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <AssistantConfigurationCard title="Connection & authentication">
              <TextField
                label="Agent name"
                maxLength={43}
                value={agent.name}
                onChange={(name) => update(index, { name })}
              />
              <TextField
                label="Agent endpoint URL"
                type="url"
                value={agent.url}
                onChange={(url) => update(index, { url })}
              />
              <details className="border-t pt-4">
                <summary className="cursor-pointer text-sm">
                  {tUi("Authentication headers")}
                </summary>
                <div className="mt-4">
                  <SchemaValue
                    schema={
                      assistantSchemas.AssistantA2AAgent.properties.headers
                    }
                    name="Headers"
                    path={`a2a_agents[${index}].headers`}
                    value={agent.headers}
                    onChange={(headers) => update(index, { headers })}
                  />
                </div>
              </details>
            </AssistantConfigurationCard>
            <AssistantConfigurationCard
              title="Response behavior"
              description="Control waiting time and messages while the remote agent works."
            >
              <label className="flex items-center justify-between gap-4 text-sm">
                {tUi("Continue the conversation while waiting")}
                <Switch
                  checked={Boolean(agent.async)}
                  onCheckedChange={(enabled) =>
                    update(index, { async: enabled })
                  }
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Response timeout (ms)"
                  type="number"
                  min={1}
                  max={4294967295}
                  value={agent.timeout_ms}
                  onChange={(timeout_ms) => update(index, { timeout_ms })}
                  placeholder="30000"
                />
                <TextField
                  label="Check for a response every (ms)"
                  type="number"
                  min={1}
                  max={4294967295}
                  value={agent.poll_interval_ms}
                  onChange={(poll_interval_ms) =>
                    update(index, { poll_interval_ms })
                  }
                  placeholder="500"
                />
              </div>
              {!agent.async ? (
                <details className="border-t pt-4">
                  <summary className="cursor-pointer text-sm">
                    {tUi("Messages while waiting")}
                  </summary>
                  <div className="mt-4">
                    <SchemaValue
                      schema={
                        assistantSchemas.AssistantA2AAgent.properties.messages
                      }
                      name="Messages"
                      path={`a2a_agents[${index}].messages`}
                      value={agent.messages}
                      onChange={(messages) => update(index, { messages })}
                    />
                  </div>
                </details>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {tUi(
                    "Waiting messages are inactive while the conversation continues. Existing messages are kept for when waiting is enabled again.",
                  )}
                </p>
              )}
            </AssistantConfigurationCard>
          </div>
        </section>
      ))}
    </div>
  );
}
