import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

// Writes Brotli and gzip copies of the built assets so the worker serves them without compressing.
const directory = join(import.meta.dir, "../dist");

for (const name of await readdir(directory)) {
  if (/\.(?:html|js|css)$/.test(name)) {
    const body = await Bun.file(join(directory, name)).bytes();

    const copies = {
      br: brotliCompressSync(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      }),
      gz: gzipSync(body, { level: 9 }),
    };

    for (const [extension, bytes] of Object.entries(copies)) {
      if (bytes.length < body.length) {
        await Bun.write(join(directory, `${name}.${extension}`), bytes);
      }
    }
  }
}
