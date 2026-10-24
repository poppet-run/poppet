import type { Run } from "@poppet/store";

// Prefer paragraph, line, then word breaks in the second half of a chunk, so replies stay
// readable without producing tiny fragments.
const breakAt = (window: string) => {
  for (const separator of ["\n\n", "\n", " "]) {
    const index = window.lastIndexOf(separator);

    if (index >= window.length / 2) return index + separator.length;
  }

  return window.length;
};

/** Splits text into chunks of at most limit UTF-16 units without splitting a code point. */
export const chunks = (text: string, limit: number) => {
  const result: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    let end = breakAt(rest.slice(0, limit));

    // Keep a surrogate pair together when the chunk ends mid-character.
    if (end === limit && /[\uD800-\uDBFF]/.test(rest[end - 1] ?? "")) end--;
    result.push(rest.slice(0, end));
    rest = rest.slice(end);
  }

  if (rest) result.push(rest);

  return result;
};

/** The reply text for a saved run's final outcome. */
export const answer = (run: Run) =>
  run.status === "completed" && run.result !== null
    ? run.result.output.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ||
      "The request completed without a text answer."
    : "The request failed or was interrupted. Inspect its saved run before sending a new request.";
