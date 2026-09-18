export function parseAttachmentByteRange(value, totalLength) {
  const total = Number(totalLength);
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || "").trim());
  if (!match || !Number.isInteger(total) || total <= 0) return null;

  const [, startValue, endValue] = match;
  if (!startValue && !endValue) return null;
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, total - suffixLength), end: total - 1 };
  }

  const start = Number(startValue);
  const requestedEnd = endValue ? Number(endValue) : total - 1;
  if (
    !Number.isInteger(start)
    || !Number.isInteger(requestedEnd)
    || start < 0
    || start >= total
    || requestedEnd < start
  ) return null;
  return { start, end: Math.min(requestedEnd, total - 1) };
}
