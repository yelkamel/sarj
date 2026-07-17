/** Dev REPL: `npm run chat` — talk to the harness in your terminal. */
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { Message, runTurn } from "./harness.js";
import { buildIndex } from "./rag.js";

const systemPrompt = await readFile(new URL("../knowledge/brand.md", import.meta.url), "utf8");
console.log(`rag: ${await buildIndex()} chunks indexed`);

const history: Message[] = [{ role: "system", content: systemPrompt }];
const rl = createInterface({ input: process.stdin, output: process.stdout });

while (true) {
  const line = (await rl.question("\nyou > ")).trim();
  if (!line || line === "exit") break;
  process.stdout.write("sarj > ");
  for await (const ev of runTurn(history, line)) {
    if (ev.type === "token") process.stdout.write(ev.data);
    if (ev.type === "tool_start") process.stdout.write(`\n  [tool: ${ev.data}…] `);
    if (ev.type === "error") console.error(`\n! ${ev.data}`);
  }
  console.log();
}
rl.close();
