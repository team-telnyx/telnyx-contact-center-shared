
import { UiText } from "@/components/i18n/use-ui-text";
export default function ConfigurationPage() {
  return (
    <div className="px-4 lg:px-6">
      <h1 className="text-3xl font-bold mb-6"><UiText>Configuration</UiText></h1>
      <p className="text-muted-foreground"><UiText>Configure agent settings and preferences.</UiText></p>
    </div>
  );
}
