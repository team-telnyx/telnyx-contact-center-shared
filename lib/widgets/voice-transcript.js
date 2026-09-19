// Assistant text streams as `response.text.delta`, and the AI Agent Library stamps
// every fragment with `${item_id}-${Date.now()}`. Dropping that timestamp regroups
// the fragments of one spoken response, which otherwise render one bubble per word.
export function transcriptGroupId(item) {
  return item.role === "assistant"
    ? String(item.id).replace(/-\d{10,}$/, "")
    : String(item.id);
}

export function mergeTranscript(current, item) {
  const id = transcriptGroupId(item);
  const index = current.findIndex((message) => message.id === id);
  if (index === -1) {
    return [...current, { ...item, id, content: item.content || "" }];
  }
  const existing = current[index];
  const next = [...current];
  next[index] = {
    ...existing,
    // Assistant fragments accumulate; a completed user item arrives whole.
    content: item.role === "assistant"
      ? `${existing.content}${item.content || ""}`
      : item.content || "",
  };
  return next;
}
