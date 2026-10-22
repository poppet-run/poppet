import { spawn } from "node:child_process";

const mode = process.argv[2];

if (mode === "report") {
  console.log(
    JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd(), env: process.env }),
  );
  console.error("separate stderr");
} else if (mode === "fail") {
  console.log("partial effect");
  process.exitCode = 7;
} else if (mode === "flood") {
  setInterval(() => {
    process.stdout.write("x".repeat(8192));
    process.stderr.write("y".repeat(8192));
  }, 1);
} else if (mode === "stubborn") {
  process.on("SIGTERM", () => undefined);
  console.log("ready");
  setInterval(() => undefined, 100);
} else if (mode === "descendant" || mode === "orphan") {
  const child = spawn(process.execPath, [import.meta.path, "stubborn"], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  console.log(JSON.stringify({ descendant: child.pid }));

  if (mode === "orphan") {
    child.unref();
    process.exit(0);
  }

  setInterval(() => undefined, 100);
} else throw new Error("Unknown command fixture mode.");
