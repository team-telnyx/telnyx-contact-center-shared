import { AgentDesktop } from "@/components/contact-center/AgentDesktop";
import { Card, CardContent } from "@/components/ui/card";

export default function DesktopPage() {
  return (
    <div className="px-0 lg:px-0 py-0">
      <div className="flex-1 min-h-0 px-4 pb-0" style={{ height: "90vh" }}>
        <AgentDesktop />
      </div>
    </div>
  );
}
