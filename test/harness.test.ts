import { describe, expect, test, beforeAll } from "@jest/globals";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLang, runTurn, MAX_TOOL_ROUNDS, Message, HarnessEvent } from "../src/harness.js";
import { buildIndex } from "../src/rag.js";
import { installFakeOllama, toolCall } from "./ollama-mock.js";

async function collect(gen: AsyncGenerator<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const fresh = (): Message[] => [{ role: "system", content: "SYSTEM" }];

describe("language pinning", () => {
  test.each([
    ["Quelle est son expérience avec Flutter ?", "fr"],
    ["C'est quoi Evolum, et pourquoi le faire seul ?", "fr"],
    ["What is his experience with Flutter?", "en"],
    ["How does the harness work?", "en"],
    ["", "en"], // empty → English, the knowledge base's language
    ["Flutter Firebase", "en"], // no hints at all → tie → English
    ["What is le projet Evolum pour les users?", "fr"], // mixed: more FR hints wins
  ])("%j → %s", (text, lang) => {
    expect(detectLang(text)).toBe(lang);
  });

  test("the pin is the last message the model sees, and stays out of history", async () => {
    const fake = installFakeOllama({ chat: [{ content: "Bonjour" }] });
    const history = fresh();
    await collect(runTurn(history, "Quelle est son expérience ?"));
    const sent = fake.chatBodies[0].messages;
    expect(sent.at(-1)).toEqual({ role: "system", content: expect.stringContaining("FRENCH") });
    expect(history.some((m) => m.content.includes("FRENCH"))).toBe(false);
  });

  test("re-pinned every turn from that turn's message", async () => {
    const fake = installFakeOllama({ chat: [{ content: "a" }] });
    const history = fresh();
    await collect(runTurn(history, "Quelle est son expérience ?"));
    await collect(runTurn(history, "What does he build?"));
    expect(fake.chatBodies[1].messages.at(-1)?.content).toContain("ENGLISH");
  });
});

describe("tool loop", () => {
  test(`stops after ${MAX_TOOL_ROUNDS} tool rounds and escalates`, async () => {
    // A model that never stops asking for a tool.
    const fake = installFakeOllama({ chat: [{ tool_calls: [toolCall("get_apps")] }] });
    const history = fresh();
    const events = await collect(runTurn(history, "list the apps"));

    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(MAX_TOOL_ROUNDS);
    expect(history.filter((m) => m.role === "tool")).toHaveLength(MAX_TOOL_ROUNDS);
    expect(fake.chatBodies).toHaveLength(MAX_TOOL_ROUNDS + 1); // last call gets its chance to answer
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.data).toContain("yelkamel@gmail.com");
    expect(history.at(-1)).toEqual({ role: "assistant", content: done.data });
  });

  test("a tool result is fed back and the model answers", async () => {
    const fake = installFakeOllama({ chat: [{ tool_calls: [toolCall("get_apps")] }, { content: "Five apps." }] });
    const events = await collect(runTurn(fresh(), "apps?"));
    expect(events.at(-1)).toEqual({ type: "done", data: "Five apps." });
    const toolMsg = fake.chatBodies[1].messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("Evolum");
  });

  test("an unknown tool is reported to the model, not thrown", async () => {
    const fake = installFakeOllama({ chat: [{ tool_calls: [toolCall("rm_rf")] }, { content: "sorry" }] });
    const events = await collect(runTurn(fresh(), "hi"));
    expect(events.at(-1)?.type).toBe("done");
    expect(fake.chatBodies[1].messages.find((m) => m.role === "tool")?.content).toMatch(/TOOL_ERROR: unknown tool "rm_rf"/);
  });

  test("a failing model call yields an error event and ends the turn", async () => {
    installFakeOllama();
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const events = await collect(runTurn(fresh(), "hi"));
    expect(events).toEqual([{ type: "error", data: expect.stringContaining("503") }]);
  });
});

describe("retry then escalation", () => {
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "sarj-kb-"));
    await writeFile(join(dir, "kb.md"), "## Flutter\nYoucef has shipped Flutter apps for years, end to end.\n");
    installFakeOllama();
    await buildIndex(dir);
  });

  test("a tool that fails once is retried and succeeds", async () => {
    let n = 0;
    const fake = installFakeOllama({
      chat: [{ tool_calls: [toolCall("search_knowledge", { query: "flutter" })] }, { content: "Yes." }],
      embed: () => { if (n++ === 0) throw new Error("flaky"); return [1, 0]; },
    });
    await collect(runTurn(fresh(), "flutter?"));
    expect(fake.embedCalls).toBe(2);
    expect(fake.chatBodies[1].messages.find((m) => m.role === "tool")?.content).toContain("Flutter");
  });

  test("a tool that fails twice becomes a TOOL_ERROR the model sees — exactly one retry", async () => {
    const fake = installFakeOllama({
      chat: [{ tool_calls: [toolCall("search_knowledge", { query: "flutter" })] }, { content: "Write to Youcef." }],
      embed: () => { throw new Error("down"); },
    });
    const events = await collect(runTurn(fresh(), "flutter?"));
    expect(fake.embedCalls).toBe(2);
    expect(fake.chatBodies[1].messages.find((m) => m.role === "tool")?.content).toMatch(/^TOOL_ERROR: .*embed failed/);
    expect(events.at(-1)).toEqual({ type: "done", data: "Write to Youcef." });
  });
});

describe("event stream", () => {
  test("order: tokens → tool_start/tool_end → tokens → done", async () => {
    installFakeOllama({
      chat: [
        { content: "Let me check. ", tool_calls: [toolCall("get_apps")] },
        { content: "He built five apps." },
      ],
    });
    const events = await collect(runTurn(fresh(), "apps?"));
    const kinds = events.map((e) => e.type);
    // collapse runs of tokens so the shape is readable
    const shape = kinds.filter((k, i) => !(k === "token" && kinds[i - 1] === "token"));
    expect(shape).toEqual(["token", "tool_start", "tool_end", "token", "done"]);
    const answer = events.filter((e) => e.type === "token").map((e) => e.data).join("");
    expect(answer).toBe("Let me check. He built five apps.");
    expect(events.at(-1)?.data).toBe("He built five apps.");
  });
});
