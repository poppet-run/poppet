/** @jsxImportSource preact */
import DOMPurify from "dompurify";
import { marked } from "marked";

export const Markdown = ({ text }: { readonly text: string }) => {
  const body = DOMPurify.sanitize(marked.parse(text, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "img",
      "style",
      "input",
      "button",
      "form",
      "video",
      "audio",
      "textarea",
      "select",
      "option",
      "fieldset",
      "label",
      "dialog",
      "meter",
      "progress",
    ],
    FORBID_ATTR: ["style"],
    RETURN_DOM: true,
  });

  for (const link of body.querySelectorAll("a[href]")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }

  return <div class="markdown" dangerouslySetInnerHTML={{ __html: body.innerHTML }} />;
};
