import { describe, expect, test } from "@jest/globals";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, chunkMarkdown, cosine, search } from "../src/rag.js";
import { installFakeOllama } from "./ollama-mock.js";

const long = (s: string) => `${s} — ${"filler text to clear the minimum size. ".repeat(2)}`;

describe("chunkMarkdown", () => {
  test("one chunk per ## heading, heading kept", () => {
    const md = `# Title\n\n## Flutter\n${long("flutter")}\n\n## Firebase\n${long("firebase")}\n`;
    const chunks = chunkMarkdown("kb.md", md);
    expect(chunks.map((c) => c.text.split("\n")[0])).toEqual(["## Flutter", "## Firebase"]);
    expect(chunks.every((c) => c.source === "kb.md")).toBe(true);
  });

  test("drops empty and tiny sections (≤ 40 chars)", () => {
    const md = `## Empty\n\n## Tiny\nshort\n\n## Real\n${long("real")}`;
    const chunks = chunkMarkdown("kb.md", md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.startsWith("## Real")).toBe(true);
  });

  test("a preamble before the first ## stays a chunk when long enough", () => {
    const chunks = chunkMarkdown("kb.md", `# About\n${long("intro")}\n## Next\n${long("next")}`);
    expect(chunks[0].text.startsWith("# About")).toBe(true);
    expect(chunks).toHaveLength(2);
  });

  test("### subheadings do not split", () => {
    expect(chunkMarkdown("kb.md", `## A\n${long("a")}\n### A.1\n${long("a1")}`)).toHaveLength(1);
  });
});

describe("cosine", () => {
  test("identical → 1, orthogonal → 0, opposite → -1", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
  test("scale-invariant", () => {
    expect(cosine([1, 1], [10, 10])).toBeCloseTo(1);
  });
  test("zero vector → 0, not NaN", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("index + search", () => {
  async function kb(files: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), "sarj-kb-"));
    for (const [name, md] of Object.entries(files)) await writeFile(join(dir, name), md);
    return dir;
  }
  // Fixed fake vectors: each chunk points along one axis, the query is a mix.
  const VECTORS: Record<string, number[]> = { flutter: [1, 0, 0], firebase: [0, 1, 0], dubai: [0, 0, 1] };
  const embedByKeyword = (text: string) =>
    Object.entries(VECTORS).find(([k]) => text.toLowerCase().includes(k))?.[1] ?? [0.1, 0.1, 0.1];

  test("ranks by cosine and keeps the top K, with source and score", async () => {
    const dir = await kb({
      "skills.md": `## Flutter\n${long("flutter")}\n## Firebase\n${long("firebase")}`,
      "life.md": `## Dubai\n${long("dubai")}`,
    });
    const fake = installFakeOllama({ embed: (t) => (t === "QUERY" ? [0.9, 0.4, 0] : embedByKeyword(t)) });
    expect(await buildIndex(dir)).toBe(3);

    const out = await search("QUERY", 2);
    const hits = out.split("\n\n---\n\n");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatch(/^\[skills\.md · 0\.91\]\n## Flutter/);
    expect(hits[1]).toMatch(/^\[skills\.md · 0\.41\]\n## Firebase/);
    expect(fake.embedCalls).toBe(4); // 3 chunks + 1 query
  });

  test("brand.md (the system prompt) is never indexed", async () => {
    const dir = await kb({ "brand.md": `## Secret rules\n${long("flutter")}`, "notes.txt": long("x") });
    installFakeOllama({ embed: embedByKeyword });
    expect(await buildIndex(dir)).toBe(0);
  });

  test("empty index → empty result, no crash, no embed call", async () => {
    const dir = await kb({});
    const fake = installFakeOllama();
    expect(await buildIndex(dir)).toBe(0);
    await expect(search("anything")).resolves.toBe("");
    expect(fake.embedCalls).toBe(0);
  });

  test("a failing embed call surfaces as an error (the harness retries it)", async () => {
    const dir = await kb({ "a.md": `## A\n${long("flutter")}` });
    installFakeOllama({ embed: embedByKeyword });
    await buildIndex(dir);
    installFakeOllama({ embed: () => { throw new Error("x"); } });
    await expect(search("q")).rejects.toThrow("embed failed: 500");
  });
});
