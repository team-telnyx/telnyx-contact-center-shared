
import { UiText } from "@/components/i18n/use-ui-text";
import { getHelpTopic } from "@/lib/help/help-registry";
import { cn } from "@/lib/utils";

/**
 * Shared renderer for contextual snippets. Full documentation pages can use
 * this component by help ID instead of duplicating the in-app help copy.
 */
export function HelpTopicContent({
  helpId,
  topic: topicOverride,
  showTitle = false,
  showSummary = true,
  className,
}) {
  const topic = topicOverride || getHelpTopic(helpId);

  if (!topic) return null;

  return (
    <div className={cn("space-y-4", className)}>
      {showTitle ? (
        <h2 className="text-lg font-semibold tracking-tight"><UiText>{topic.title}</UiText></h2>
      ) : null}
      {showSummary ? (
        <p className="text-sm leading-6 text-muted-foreground">
          <UiText>{topic.summary}</UiText>
        </p>
      ) : null}
      {topic.paragraphs?.map((paragraph) => (
        <p key={paragraph} className="text-sm leading-6">
          <UiText>{paragraph}</UiText>
        </p>
      ))}
      {topic.tips?.length ? (
        <div className="rounded-lg border bg-muted/40 p-4">
          <h3 className="mb-2 text-sm font-medium"><UiText>Good to know</UiText></h3>
          <ul className="list-disc space-y-2 pl-5 text-sm leading-5 text-muted-foreground">
            {topic.tips.map((tip) => (
              <li key={tip}><UiText>{tip}</UiText></li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default HelpTopicContent;
