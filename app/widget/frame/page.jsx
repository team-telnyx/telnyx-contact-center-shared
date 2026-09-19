import WidgetFrame from "@/components/widget/WidgetFrame";

export const metadata = { title: "Contact widget" };

export default function WidgetFramePage() {
  return (
    <>
      {/* The panel draws its own rounded surface inside a transparent iframe, so
          the document behind it must not paint the app background into the corners.
          A different color scheme from the embedding iframe makes the browser paint
          an opaque canvas even with transparent backgrounds. Override next-themes'
          inline color-scheme for this document; widget colors come from its config. */}
      <style dangerouslySetInnerHTML={{ __html: "html{color-scheme:normal!important}html,body{background:transparent}" }} />
      <WidgetFrame />
    </>
  );
}
