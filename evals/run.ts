/**
 * Evals — because an unmeasured agent is just a vibe.
 *
 * Each scenario sends one message to a FRESH session and checks the final
 * answer against simple assertions:
 *   expect_any   at least one substring must appear (case-insensitive)
 *   forbid_any   none of these substrings may appear
 *   expect_tool  this tool must have been called
 *   expect_lang  "fr" → the reply should look French
 *
 * Deliberately string-based, not LLM-judged: deterministic, fast, free.
 * An LLM judge would be the next step for nuance — this is the smoke layer.
 */

import { readFile } from "node:fs/promises";
import { Message, runTurn } from "../src/harness.js";
import { buildIndex } from "../src/rag.js";

interface Scenario {
  id: string;
  message: string;
  expect_any?: string[];
  forbid_any?: string[];
  expect_tool?: string;
  expect_lang?: "fr" | "en";
}

const scenarios: Scenario[] = JSON.parse(
  await readFile(new URL("./scenarios.json", import.meta.url), "utf8"),
);
const systemPrompt = await readFile(new URL("../knowledge/brand.md", import.meta.url), "utf8");
await buildIndex();

// Cheap language detection: stopwords unique to each language. Good enough to
// catch drift ("English question → French answer"), which is what we're testing.
const looksFrench = (s: string) =>
  / le | la | les | est | de | une | pas | je | vous | sur /i.test(` ${s} `);
const looksEnglish = (s: string) =>
  / the | is | and | of | to | for | with | his | you /i.test(` ${s} `);

const speaks = (s: string, lang: "fr" | "en") =>
  lang === "fr" ? looksFrench(s) && !looksEnglish(s) : looksEnglish(s) && !looksFrench(s);

let passed = 0;
const failures: string[] = [];

for (const sc of scenarios) {
  const history: Message[] = [{ role: "system", content: systemPrompt }];
  const toolsUsed: string[] = [];
  let answer = "";

  for await (const ev of runTurn(history, sc.message)) {
    if (ev.type === "tool_start") toolsUsed.push(ev.data);
    if (ev.type === "done") answer = ev.data;
    if (ev.type === "error") answer = `ERROR: ${ev.data}`;
  }

  const lower = answer.toLowerCase();
  const problems: string[] = [];

  if (sc.expect_any && !sc.expect_any.some((e) => lower.includes(e.toLowerCase())))
    problems.push(`missing any of [${sc.expect_any}]`);
  if (sc.forbid_any) {
    const hit = sc.forbid_any.find((f) => lower.includes(f.toLowerCase()));
    if (hit) problems.push(`forbidden "${hit}" present`);
  }
  if (sc.expect_tool && !toolsUsed.includes(sc.expect_tool))
    problems.push(`tool ${sc.expect_tool} not called (used: ${toolsUsed.join(",") || "none"})`);
  if (sc.expect_lang && !speaks(answer, sc.expect_lang))
    problems.push(`reply not in ${sc.expect_lang} (language drift)`);

  if (problems.length === 0) {
    passed++;
    console.log(`✅ ${sc.id}`);
  } else {
    failures.push(sc.id);
    console.log(`❌ ${sc.id} — ${problems.join(" · ")}\n   ↳ "${answer.slice(0, 140)}"`);
  }
}

console.log(`\n${passed}/${scenarios.length} passed (${Math.round((passed / scenarios.length) * 100)}%)`);
if (failures.length) process.exit(1);
