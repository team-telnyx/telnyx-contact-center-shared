import { AgentDesktop } from "@/components/contact-center/AgentDesktop";
import {
  AgentPageContent,
  AgentPageHeader,
  AgentPageShell,
} from "@/components/contact-center/WorkspacePageLayout";

export default function DesktopPage() {
  return (
    <AgentPageShell>
      <AgentPageHeader title="Agent Desktop" />
      <AgentPageContent className="overflow-hidden">
        <AgentDesktop />
      </AgentPageContent>
    </AgentPageShell>
  );
}
