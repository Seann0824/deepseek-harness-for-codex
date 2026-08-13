const [behavior, task = ""] = process.argv.slice(2);

if (behavior === "hang") {
  process.stdout.write(`started:${task}\n`);
  setInterval(() => process.stdout.write("tick\n"), 50);
} else if (behavior === "fail") {
  process.stderr.write(`failed:${task}\n`);
  process.exitCode = 7;
} else if (behavior === "large") {
  process.stdout.write("abcdefghij");
} else {
  process.stdout.write(`completed:${task}\n`);
  process.stderr.write("diagnostic\n");
}
