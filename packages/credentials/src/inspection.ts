import { join } from "node:path";

import { ensurePrivateDirectory, readProtectedFile } from "@poppet/io";

export const readCredentialFile = async (directory: string, name: string) => {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) {
    throw new Error("Invalid credential name");
  }

  if (!(await ensurePrivateDirectory(join(directory, "auth"), { create: false, strict: true }))) {
    return null;
  }

  return readProtectedFile(join(directory, "auth", name), {
    maxBytes: 65_536,
    privateOnly: true,
    strictUtf8: true,
  });
};
