/** English fallback for shared display helpers that also run outside React. */
export function sourceText(source, values) {
  return values ? source.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match) : source;
}
