/** @jsxImportSource preact */
import { useStore } from "@nanostores/preact";
import { atom, onMount } from "nanostores";
import { useMemo } from "preact/hooks";

import type { renderMarkdown } from "./render-markdown";

/** Holds the Markdown renderer module once its chunk loads, so the first page stays small. */
export const $markdownRenderer = atom<
  { readonly renderMarkdown: typeof renderMarkdown } | undefined
>();

onMount($markdownRenderer, () => {
  if ($markdownRenderer.get() === undefined) {
    // If the chunk fails to load, replies stay plain text and the next mount retries.
    import("./render-markdown").then(
      (module) => $markdownRenderer.set(module),
      () => undefined,
    );
  }
});

export const Markdown = ({ text }: { readonly text: string }) => {
  const renderer = useStore($markdownRenderer);
  const html = useMemo(() => renderer?.renderMarkdown(text), [renderer, text]);

  return html === undefined ? (
    <div class="whitespace-pre-wrap">{text}</div>
  ) : (
    <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />
  );
};
