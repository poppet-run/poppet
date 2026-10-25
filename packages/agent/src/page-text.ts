import { fitText } from "@poppet/io";
import { decodeHTML } from "entities/decode";

import { AgentError } from "#src/errors";
import { maxPageBytes, pageFailure } from "#src/page-network";

const textPage = (body: Uint8Array, contentType: string | undefined) => {
  if (body.byteLength > maxPageBytes)
    throw new AgentError({ reason: "tool-limit", message: "The decoded page exceeds 1 MiB." });
  const [mime, ...parameters] = (contentType ?? "").toLowerCase().split(";");

  if (!["text/plain", "text/html"].includes(mime?.trim() ?? ""))
    throw new AgentError({
      reason: "tool-network",
      message: "Page reading supports only UTF-8 text/plain and static text/html.",
    });

  for (const parameter of parameters) {
    const [name, value] = parameter.split("=").map((part) => part.trim());

    if (name === "charset" && !/^(?:utf-8|utf8|"utf-8"|"utf8")$/.test(value ?? ""))
      throw new AgentError({
        reason: "tool-network",
        message: "The page declares an unsupported character encoding; only UTF-8 is supported.",
      });
  }

  const source = new TextDecoder("utf-8", { fatal: true }).decode(body);

  if (mime?.trim() === "text/plain") return { text: source.trim(), title: null };
  let title = "";

  const cleaned = new HTMLRewriter()
    .on("meta", {
      element: (element) => {
        const charset =
          element.getAttribute("charset") ??
          /charset\s*=\s*["']?([^\s;"']+)/i.exec(element.getAttribute("content") ?? "")?.[1];

        if (charset !== undefined && charset !== null && !/^utf-?8$/i.test(charset.trim()))
          throw pageFailure();
      },
    })
    .on("title", {
      text: (chunk) => {
        title += chunk.text;
      },
    })
    .on(
      'head,title,script,style,noscript,template,svg,canvas,iframe,object,nav,header,footer,form,[hidden],[aria-hidden="true"]',
      {
        element: (element) => {
          element.remove();
        },
      },
    )
    .on("p,div,section,article,main,aside,h1,h2,h3,h4,h5,h6,li,ul,ol,pre,blockquote,br,tr,hr", {
      element: (element) => {
        element.before("\u0001");
        element.after("\u0001");
      },
    })
    .on("td,th", {
      element: (element) => {
        element.after(" ");
      },
    })
    .transform(source);

  const parts: string[] = [];
  let text = "";
  let preformatted = false;

  const flush = () => {
    const decoded = decodeHTML(text);
    parts.push(
      preformatted
        ? decoded
            .split("\u0001")
            .filter((part) => part.length > 0)
            .join("\n")
        : decoded
            .replace(/\s+/g, " ")
            .split("\u0001")
            .map((part) => part.trim())
            .join("\n")
            .replace(/\n+/g, "\n")
            .trim(),
    );
    text = "";
  };

  // Removed elements still emit text callbacks. Parse the cleaned document before collecting text.
  new HTMLRewriter()
    .on("pre", {
      element: (element) => {
        flush();
        preformatted = true;
        element.onEndTag(() => {
          flush();
          preformatted = false;
        });
      },
    })
    .onDocument({
      text: (chunk) => {
        text += chunk.text;
      },
    })
    .transform(cleaned);
  flush();

  return {
    text: parts.filter((part) => part.length > 0).join("\n"),
    title: Array.from(decodeHTML(title).replace(/\s+/g, " ").trim()).slice(0, 256).join("") || null,
  };
};

export const pageResult = (
  url: URL,
  body: Uint8Array,
  contentType: string | undefined,
  limit: number,
) => {
  const page = textPage(body, contentType);

  if (page.text.trim().length === 0)
    throw new AgentError({
      reason: "tool-network",
      message: "The page contains no usable static text. JavaScript rendering is unsupported.",
    });

  const output = fitText(page.text, limit, (text, truncated) =>
    JSON.stringify({ url: url.href, title: page.title, text, truncated }),
  );

  if (output === null)
    throw new AgentError({
      reason: "tool-limit",
      message: "The page metadata exceeds the tool-result budget.",
    });

  return output;
};
