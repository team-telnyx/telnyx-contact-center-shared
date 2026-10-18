
import { UiText } from "@/components/i18n/use-ui-text";
export default function Page() {
  return <main className="m-0 min-h-screen bg-emerald-50 p-4 font-sans text-emerald-950">
    <strong><UiText>Same-origin embedded document</UiText></strong>
    <p className="mt-2 text-sm"><UiText>SAME_ORIGIN_FRAME_MARKER · public fixture content</UiText></p>
  </main>;
}
