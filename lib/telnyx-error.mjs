export function telnyxErrorDetail(input, fallback = "Telnyx API request failed") {
  let data = input;
  if (typeof data === "string") {
    const text = data.trim();
    if (!text) return fallback;
    try {
      data = JSON.parse(text);
    } catch {
      return text;
    }
  }

  const firstError = Array.isArray(data?.errors) ? data.errors[0] : null;
  return (
    firstError?.detail ||
    firstError?.title ||
    data?.detail ||
    data?.message ||
    (typeof data?.error === "string" ? data.error : null) ||
    fallback
  );
}
