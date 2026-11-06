/** @jsxImportSource preact */
import DOMPurify from "dompurify";
import { marked } from "marked";

export const Markdown = ({ text }: { readonly text: string }) => {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "input", "button", "form", "video", "audio"],
    FORBID_ATTR: ["style"],
  });

  return <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
};
