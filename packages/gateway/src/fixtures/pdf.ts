/** Small local text fixtures with real cross-reference offsets and WinAnsi Unicode mapping. */
export const textPDF = (pages: ReadonlyArray<string>) => {
  const font = 3 + pages.length * 2;

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...pages.flatMap((text, index) => {
      const stream = `BT /F1 ${text.length > 500 ? "0.01" : "12"} Tf 20 750 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`;

      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
      ];
    }),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];

  let content = "%PDF-1.7\n";
  const offsets = [0];

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content, "latin1"));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const start = Buffer.byteLength(content, "latin1");
  content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;

  return new Uint8Array(Buffer.from(content, "latin1"));
};
