export const bashFixtures = {
  output: "printf 'hello' > result; cat result; printf 'problem' >&2; exit 7",
  overflow: "yes output | head -c 100000",
  unicode: "printf 'a🌻b'; printf '🌻a' >&2",
  timeout: "sleep 10",
  background: "sleep 10 & echo $!",
  cancellation: "echo $$ > pid; sleep 30",
  missingDirectory: "echo unwanted",
};
