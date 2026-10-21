import { getDocumentProxy } from "unpdf";

// Parsing is text-only in a disposable process; PDFs never get a network or script runtime.
globalThis.fetch = Object.assign(() => Promise.reject(new Error("PDF network access disabled")), {
  preconnect: () => {
    throw new Error("PDF network access disabled");
  },
});

const run = async () => {
  const data = new Uint8Array(await Bun.file(process.argv[2]!).arrayBuffer());

  const settings = {
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    disableAutoFetch: true,
    stopAtErrors: true,
    verbosity: 0,
  };

  const pdf = await getDocumentProxy(data, settings);

  if ((await pdf.getPermissions()) !== null) throw new Error("Encrypted PDF");

  if (pdf.numPages > 64) throw new Error("PDF exceeds 64 pages.");
  let text = "";
  let lastPage = 0;
  let truncated = false;

  for (let number = 1; number <= pdf.numPages; number++) {
    // eslint-disable-next-line no-await-in-loop -- One page at a time bounds retained page data.
    const page = await pdf.getPage(number);
    // eslint-disable-next-line no-await-in-loop
    const content = await page.getTextContent();

    const value = content.items
      .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
      .join("")
      .trim();

    const labelled = `\n[Page ${number}]\n${value}\n`;
    const remaining = 32768 - Buffer.byteLength(text);

    if (Buffer.byteLength(labelled) > remaining) {
      // Decode only complete UTF-8 code points at the excerpt boundary.
      text += new TextDecoder()
        .decode(Buffer.from(labelled).subarray(0, Math.max(0, remaining - 3)))
        .replace(/\uFFFD$/, "");
      truncated = true;
      lastPage = number;
      break;
    }

    text += labelled;
    lastPage = number;
    page.cleanup();
  }

  if (!text.replace(/\[Page \d+\]/g, "").trim())
    throw new Error("PDF has no extractable text; OCR is not supported.");
  await pdf.cleanup();

  return {
    text,
    completeness: truncated
      ? `Partial text: pages 1-${lastPage} of ${pdf.numPages}; page ${lastPage} is cut off and all later text/pages are omitted.`
      : `Text extracted from all ${pdf.numPages} pages. Images, diagrams and layout are not interpreted.`,
  };
};

try {
  console.log(JSON.stringify(await run()));
} catch (cause) {
  const message =
    cause instanceof Error &&
    ["PDF exceeds 64 pages.", "PDF has no extractable text; OCR is not supported."].includes(
      cause.message,
    )
      ? cause.message
      : "Cannot extract this PDF. It may be encrypted, malformed, or use unsupported text encoding.";

  console.log(JSON.stringify({ failure: message }));
}
