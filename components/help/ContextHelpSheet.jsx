"use client";

import { IconExternalLink, IconHelpCircle } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { HelpTopicContent } from "@/components/help/HelpTopicContent";
import { useHelp } from "@/components/help/HelpProvider";

export function ContextHelpSheet() {
  const { isOpen, portalContainer, setOpen, topic } = useHelp();

  return (
    <Sheet modal={false} open={isOpen} onOpenChange={setOpen}>
      <SheetContent
        id="context-help-sheet"
        side="right"
        showOverlay={false}
        portalContainer={portalContainer || undefined}
        data-context-help-sheet="true"
        className="w-full gap-0 p-0 sm:max-w-md"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <SheetHeader className="border-b px-6 py-5 pr-12">
          <div className="mb-1 flex items-center gap-2">
            <IconHelpCircle className="size-4 text-telnyx-green" />
            <Badge variant="secondary">
              {topic.scope === "field" ? "Field help" : "Screen help"}
            </Badge>
          </div>
          <div aria-live="polite">
            <SheetTitle className="text-xl">{topic.title}</SheetTitle>
            <SheetDescription className="mt-1 leading-5">
              {topic.summary}
            </SheetDescription>
          </div>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <HelpTopicContent
            topic={topic}
            showSummary={false}
            className="p-6"
          />
        </ScrollArea>

        <SheetFooter className="border-t bg-background/80 px-6 py-4">
          <Button asChild className="w-full">
            <a href={topic.articleHref} target="contact-center-help">
              Open full article
              <IconExternalLink aria-hidden="true" />
            </a>
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export default ContextHelpSheet;
