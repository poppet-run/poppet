export const bashFixtures = {
  output: "printf 'hello' > result; cat result; printf 'problem' >&2; exit 7",
  overflow: "yes output | head -c 100000",
  unicode: "printf 'a🌻b'; printf '🌻a' >&2",
  timeout: "sleep 10",
  background: "sleep 10 & echo $!",
  cancellation: "echo $$ > pid; sleep 30",
  environment: 'printf \'%s|%s|%s\' "$POPPET_TEST_KEY" "$CDPATH" "${PATH:+present}"',
  detachedPipe: "perl -MPOSIX -e 'POSIX::setsid(); select(undef,undef,undef,3);' & wait",
  missingDirectory: "echo unwanted",
};
