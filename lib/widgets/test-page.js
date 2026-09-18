// Shared by the widget test page and the host page it frames.
export const WIDGET_TEST_CONTEXT_KEY = "cc.widgetTest.context";

// Shown until the user stores a context of their own (an emptied field stays empty).
export const WIDGET_TEST_DEFAULT_CONTEXT = JSON.stringify({
  first_name: "Anna",
  last_name: "Kowalska",
  company: "Example Company",
  phone_number: "+12025550123",
  email: "anna.kowalska@example.com",
}, null, 2);

export function storedWidgetTestContext(storage) {
  try {
    const value = storage.getItem(WIDGET_TEST_CONTEXT_KEY);
    return value === null ? WIDGET_TEST_DEFAULT_CONTEXT : value;
  } catch {
    return WIDGET_TEST_DEFAULT_CONTEXT;
  }
}

// The host context accepts flat scalar values only, like window.TelnyxWidget.setContext.
export function parseWidgetTestContext(text) {
  const source = String(text || "").trim();
  if (!source) return { context: {}, error: null };
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return { context: null, error: "Context is not valid JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { context: null, error: "Context must be a JSON object" };
  const nested = Object.keys(value).find((key) => value[key] !== null && typeof value[key] === "object");
  if (nested) return { context: null, error: `"${nested}" must be a text, number or boolean value` };
  return { context: value, error: null };
}
