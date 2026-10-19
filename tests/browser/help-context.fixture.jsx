import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { HelpProvider, useHelp } from "@/components/help/HelpProvider";
import { ContextHelpSheet } from "@/components/help/ContextHelpSheet";
import { NavigationFixture } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

function Controls() {
  const { openHelp } = useHelp();
  useEffect(() => {
    window.fixture.openHelp = openHelp;
  }, [openHelp]);
  return (
    <>
      <button id="screen-control">Screen control</button>
      <label data-help-id="admin.queues.form.max-wait-time">
        Maximum wait time <input id="queue-field" />
      </label>
      <section data-help-id="admin.call-flows.schedules">
        <button id="schedule-control">Test schedule</button>
        <section data-help-id="admin.call-flows.assistant-invite">
          <button id="invite-control">Select assistant</button>
        </section>
      </section>
      <button id="invalid-context" data-help-id="unknown.help.id">Unknown context</button>
      <Dialog>
        <DialogTrigger id="modal-trigger">Move call</DialogTrigger>
        <DialogContent data-help-id="phone.devices">
          <DialogTitle>Move call</DialogTitle>
          <DialogDescription>Select a destination for this test interaction.</DialogDescription>
          <button id="modal-control">Choose destination</button>
        </DialogContent>
      </Dialog>
      <ContextHelpSheet />
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <NavigationFixture>
    <HelpProvider><Controls /></HelpProvider>
  </NavigationFixture>,
);
