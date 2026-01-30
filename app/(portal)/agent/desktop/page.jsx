import { AgentDesktop } from "@/components/contact-center/AgentDesktop";
import { Card, CardContent } from "@/components/ui/card";

export default function DesktopPage() {
  return (
    <div
      className="flex flex-col overflow-hidden w-full"
      style={{
        height: "calc(92vh - var(--header-height, 3rem) + 2rem)",
        maxHeight: "calc(92vh - var(--header-height, 3rem) + 2rem)",
        maxWidth: "100%",
        overflow: "hidden",
      }}
    >
      <div
        className="w-full px-4 md:px-6 min-h-0 overflow-hidden"
        style={{
          height: "100%",
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          maxWidth: "100%",
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        <AgentDesktop />
      </div>
    </div>
  );
}
