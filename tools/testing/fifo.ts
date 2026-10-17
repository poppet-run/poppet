import { dlopen, ptr } from "bun:ffi";

/** Creates a named-pipe fixture without allowing system commands through the test guards. */
export const makeFIFO = (path: string) => {
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    mkfifo: { args: ["ptr", "u32"], returns: "i32" },
  });

  try {
    const name = Buffer.from(`${path}\0`);

    if (libc.symbols.mkfifo(ptr(name), 0o600) !== 0)
      throw new Error("Could not create FIFO fixture");
  } finally {
    libc.close();
  }
};
