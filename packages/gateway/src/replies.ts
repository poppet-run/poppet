import { outputText } from "@poppet/provider";
import type { Run } from "@poppet/store";

const breakAt = (window: string) => {
  for (const separator of ["\n\n", "\n", " "]) {
    const index = window.lastIndexOf(separator);

    if (index >= window.length / 2) return index + separator.length;
  }

  return window.length;
};

export const chunks = (text: string, limit: number) => {
  const result: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    let end = breakAt(rest.slice(0, limit));

    if (end === limit && /[\uD800-\uDBFF]/.test(rest[end - 1] ?? "")) end--;
    result.push(rest.slice(0, end));
    rest = rest.slice(end);
  }

  if (rest) result.push(rest);

  return result;
};

export const answer = (run: Run) =>
  run.status === "completed" && run.result !== null
    ? outputText(run.result.output) || "The request completed without a text answer."
    : "The request failed or was interrupted. Inspect its saved run before sending a new request.";
