import { AgentDesktop } from "@/components/contact-center/AgentDesktop";
import {
  AgentPageHeader,
  AgentPageShell,
} from "@/components/contact-center/WorkspacePageLayout";

export default function DesktopPage() {
  return (
    <AgentPageShell>
      <AgentPageHeader title="Agent Desktop" />
      <AgentDesktop />
    </AgentPageShell>
  );
}
