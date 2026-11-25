/** @jsxImportSource preact */
import { Marked } from "marked";
import { useMemo } from "preact/hooks";

const escapeHtml = (text: string) =>
  text.replaceAll(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );

// Attribute-free inline tags that models use in replies and tables, such as `<br>`.
const inlineTag = /^<\/?(?:br|b|i|em|strong|s|del|sub|sup|kbd)\s*\/?>$/i;

const linkProtocols = new Set(["http:", "https:", "mailto:"]);

// Parse the URL the way the browser will, so encoded or spaced schemes cannot slip past.
const safeHref = (href: string) => {
  try {
    return linkProtocols.has(new URL(href, "https://relative.invalid/").protocol);
  } catch {
    return false;
  }
};

// Every tag in the output comes from marked's renderer: raw HTML is shown as text,
// links keep only allowed schemes, and images and task checkboxes are dropped.
const markdown = new Marked({
  async: false,
  renderer: {
    html: ({ text, block }) => (!block && inlineTag.test(text) ? text : escapeHtml(text)),
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);

      return safeHref(href)
        ? `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""} target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    },
    image: ({ text }) => escapeHtml(text),
    checkbox: () => "",
  },
});

export const Markdown = ({ text }: { readonly text: string }) => {
  const html = useMemo(() => markdown.parse(text, { async: false }), [text]);

  return <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
};
