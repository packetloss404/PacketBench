// Deliberately harmless interactive process; this is not a provider CLI.
import readline from "node:readline";

const line = (text) => process.stdout.write(`${text}\n`);
line(`WS_READY:stdin=${Number(!!process.stdin.isTTY)}:stdout=${Number(!!process.stdout.isTTY)}`);
line(`WS_CWD:${process.cwd()}`);
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", async (text) => {
  if (text === "PING:日本語🦀") line("WS_PONG:日本語🦀");
  else if (text === "PING:AFTER_BURST") line("WS_PONG:AFTER_BURST");
  else if (text === "SIZE") line(`WS_SIZE:${process.stdout.rows}:${process.stdout.columns}`);
  else if (text === "BURST") {
    for (let index = 0; index < 10_000; index++) {
      const chunk = `WS_BURST_LINE_${String(index).padStart(5, "0")}:${"x".repeat(200)}\n`;
      if (!process.stdout.write(chunk))
        await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    line("WS_BURST_DONE:10000");
  } else if (text === "EXIT:0" || text === "EXIT:7") {
    const code = Number(text.slice(-1));
    process.stdout.write(`WS_FINAL:${code}\n`, () => process.exit(code));
  }
});
