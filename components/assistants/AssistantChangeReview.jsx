"use client";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { payloadForSave } from "@/lib/ai/assistant-draft.mjs";
import {
  assistantChangeRows,
  redactAssistantSettings,
  settingLabel,
} from "@/lib/ai/assistant-setting-presentation.mjs";
export default function AssistantChangeReview({ values, assistantId = "", open, onOpenChange }) {
  const tUi = useUiText();
  let payload = {},
    error = "";
  try {
    // Once Telnyx has accepted a created assistant the editor saves patches, even while the draft
    // still has no id (its verification pending): the preview follows the same rule as the save.
    payload = payloadForSave(values, { patch: Boolean(assistantId || values.id) });
  } catch (e) {
    error = e.message;
  }
  const rows = assistantChangeRows(
    values._writableBaseline || values._original,
    payload,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tUi("Review changes")}</DialogTitle>
          <DialogDescription>
            {tUi(
              "These settings will be submitted when you save. The result is checked with a separate read from Telnyx.",
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.path} className="space-y-2 py-4 text-sm">
              <div className="font-medium">
                {tUi(row.label)}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {tUi(settingLabel(row.path.split(".")[0]))}
                </span>
              </div>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0 rounded-lg bg-muted/40 p-3">
                  <div className="mb-1 text-xs text-muted-foreground">
                    {tUi("Before")}
                  </div>
                  <p className="line-clamp-4 break-words whitespace-pre-wrap">
                    {tUi(row.before)}
                  </p>
                </div>
                <div className="min-w-0 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <div className="mb-1 text-xs text-muted-foreground">
                    {tUi("After")}
                  </div>
                  <p className="line-clamp-4 break-words whitespace-pre-wrap">
                    {tUi(row.after)}
                  </p>
                </div>
              </div>
            </li>
          ))}
          {!rows.length && !error ? (
            <li className="py-4 text-sm text-muted-foreground">
              {tUi("No changes to save.")}
            </li>
          ) : null}
        </ul>
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {tUi("API request preview")}
          </summary>
          <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">
            {JSON.stringify(redactAssistantSettings(payload), null, 2)}
          </pre>
        </details>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          {tUi("Close")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
