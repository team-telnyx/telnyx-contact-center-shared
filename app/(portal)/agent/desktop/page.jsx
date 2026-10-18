import { UiText } from "@/components/i18n/use-ui-text";
import { AgentDesktop } from "@/components/contact-center/AgentDesktop";
import {
  AgentPageHeader,
  AgentPageShell,
} from "@/components/contact-center/WorkspacePageLayout";

export default function DesktopPage() {
  return (
    <AgentPageShell>
      <AgentPageHeader title={<UiText>Agent Desktop</UiText>} />
      <AgentDesktop />
    </AgentPageShell>
  );
}
