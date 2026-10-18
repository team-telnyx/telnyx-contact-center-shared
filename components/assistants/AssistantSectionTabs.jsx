"use client";
import * as Tabs from "@radix-ui/react-tabs";
import { useUiText } from "@/components/i18n/use-ui-text";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";

// The platform tab style is defined once in components/ui/tabs.jsx.
export const assistantTabListClass = tabsListClass;
export const assistantTabTriggerClass = tabsTriggerClass;

/** Local navigation only; the existing SectionRail remains the primary navigation. */
export default function AssistantSectionTabs({
  value,
  onValueChange,
  tabs,
  label,
  children,
}) {
  const tUi = useUiText();
  return (
    <Tabs.Root
      value={value}
      onValueChange={onValueChange}
      className="flex h-full min-h-0 flex-col gap-5"
    >
      <Tabs.List
        aria-label={tUi(label)}
        className={assistantTabListClass}
      >
        {tabs.map((tab) => (
          <Tabs.Trigger
            key={tab.id}
            value={tab.id}
            className={assistantTabTriggerClass}
          >
            {tUi(tab.label)}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map((tab) => (
        <Tabs.Content
          key={tab.id}
          value={tab.id}
          className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {value === tab.id ? children(tab.id) : null}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
