"use client";
import { useState } from "react";
import { useUiText } from "@/components/i18n/use-ui-text";
import AssistantConfigurationCard from "./AssistantConfigurationCard";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function AssistantWidgetSettings({
  values,
  setValues,
  section = "all",
}) {
  const tUi = useUiText();
  const widget = values.widget_settings || {};
  const [editingCustomPreset, setEditingCustomPreset] = useState(false);
  const preset = widget.audio_visualizer_config?.preset ?? "";
  const presetMode = editingCustomPreset || (preset && preset !== "roundBars")
    ? "custom" : "roundBars";
  function updatePreset(preset) {
    update("audio_visualizer_config", { ...widget.audio_visualizer_config, preset });
  }
  function update(key, value) {
    setValues((v) => ({
      ...v,
      widget_settings: { ...v.widget_settings, [key]: value },
    }));
  }
  function field(key, label, options, fallback) {
    return (
      <div
        key={key}
        className="space-y-2"
        data-setting-path={`widget_settings.${key}`}
      >
        <Label htmlFor={`widget-${key}`}>{tUi(label)}</Label>
        {Array.isArray(options) ? (
          <Select
            value={widget[key] || fallback}
            onValueChange={(value) => update(key, value)}
          >
            <SelectTrigger id={`widget-${key}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {widget[key] &&
              !options.some(([value]) => value === widget[key]) ? (
                <SelectItem value={widget[key]}>{widget[key]}</SelectItem>
              ) : null}
              {options.map(([value, title]) => (
                <SelectItem key={value} value={value}>
                  {tUi(title)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={`widget-${key}`}
            type={options === "url" ? "url" : "text"}
            value={widget[key] ?? ""}
            onChange={(e) =>
              update(key, e.target.value || (options === "url" ? null : ""))
            }
          />
        )}
      </div>
    );
  }
  if (section === "all")
    return (
      <div className="space-y-5">
        <AssistantWidgetSettings
          values={values}
          setValues={setValues}
          section="appearance"
        />
        <AssistantWidgetSettings
          values={values}
          setValues={setValues}
          section="behavior"
        />
      </div>
    );
  if (section === "appearance")
    return (
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <AssistantConfigurationCard
          title="Brand & theme"
          description="Match the widget to your website."
        >
          {field(
            "theme",
            "Theme",
            [
              ["dark", "Dark"],
              ["light", "Light"],
            ],
            "dark",
          )}
          {field("logo_icon_url", "Logo image URL", "url")}
        </AssistantConfigurationCard>
        <AssistantConfigurationCard
          title="Voice visualization"
          description="Choose the appearance of the audio animation."
          data-setting-path="widget_settings.audio_visualizer_config"
        >
          <div className="space-y-2">
            <Label htmlFor="widget-visualizer-color">
              {tUi("Color palette")}
            </Label>
            <Select
              value={widget.audio_visualizer_config?.color || "verdant"}
              onValueChange={(color) =>
                update("audio_visualizer_config", {
                  ...widget.audio_visualizer_config,
                  color,
                })
              }
            >
              <SelectTrigger id="widget-visualizer-color" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  ...new Set(
                    [
                      "verdant",
                      "twilight",
                      "bloom",
                      "mystic",
                      "flare",
                      "glacier",
                      widget.audio_visualizer_config?.color,
                    ].filter(Boolean),
                  ),
                ].map((color) => (
                  <SelectItem key={color} value={color}>
                    {tUi(color[0].toUpperCase() + color.slice(1))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="widget-visualizer-preset">
              {tUi("Animation style")}
            </Label>
            <Select
              value={presetMode}
              onValueChange={(mode) => {
                setEditingCustomPreset(mode === "custom");
                if (mode !== "custom") updatePreset("roundBars");
              }}
            >
              <SelectTrigger id="widget-visualizer-preset" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="roundBars">{tUi("Rounded bars (default)")}</SelectItem>
                <SelectItem value="custom">{tUi("Custom style")}</SelectItem>
              </SelectContent>
            </Select>
            {presetMode === "custom" && <div className="space-y-2 pt-2">
              <Label htmlFor="widget-custom-visualizer-preset">{tUi("Custom animation style")}</Label>
              <Input id="widget-custom-visualizer-preset" value={preset} onChange={event => updatePreset(event.target.value)} aria-describedby="widget-custom-preset-help" />
              <p id="widget-custom-preset-help" className="text-xs text-muted-foreground">{tUi("Enter an animation style supported by Telnyx. Choose Rounded bars to restore the default style.")}</p>
            </div>}
          </div>
        </AssistantConfigurationCard>
      </div>
    );
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <AssistantConfigurationCard
        title="Placement & opening"
        description="Control how the widget appears when someone visits your website."
      >
        {field(
          "position",
          "Placement",
          [
            ["fixed", "Fixed to the page"],
            ["static", "Inside page content"],
          ],
          "fixed",
        )}
        {field(
          "default_state",
          "Initial state",
          [
            ["collapsed", "Collapsed"],
            ["expanded", "Expanded"],
          ],
          "collapsed",
        )}
      </AssistantConfigurationCard>
      <AssistantConfigurationCard
        title="Conversation copy"
        description="Write the short messages visitors see during a conversation."
      >
        {field("start_call_text", "Start conversation button")}
        {field("agent_thinking_text", "While the assistant is thinking")}
        {field("speak_to_interrupt_text", "Interruption hint")}
      </AssistantConfigurationCard>
      <AssistantConfigurationCard
        title="Support links"
        description="Optional links for history, help and feedback."
      >
        {field("view_history_url", "Conversation history URL", "url")}
        {field("report_issue_url", "Report an issue URL", "url")}
        {field("give_feedback_url", "Feedback URL", "url")}
      </AssistantConfigurationCard>
    </div>
  );
}
