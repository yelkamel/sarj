/**
 * RAG from scratch — no vector DB, no library.
 *
 * The knowledge base is a folder of markdown files. At boot we split them
 * into chunks, embed each chunk once with a local embedding model, and keep
 * everything in memory. Retrieval is a cosine similarity over ~a few dozen
 * vectors — a for-loop, not an infrastructure problem.
 *
 * This is the right size of solution for the right size of data. When the
 * corpus outgrows RAM, THEN you reach for sqlite-vec or pgvector.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.SARJ_EMBED_MODEL ?? "nomic-embed-text";
const KNOWLEDGE_DIR = new URL("../knowledge/", import.meta.url).pathname;

interface Chunk {
  source: string; // filename, cited back in results
  text: string;
  vector: number[];
}

let index: Chunk[] = [];

// --- embedding ------------------------------------------------------------

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status}`);
  const json = (await res.json()) as { embeddings: number[][] };
  return json.embeddings[0];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- indexing -------------------------------------------------------------

/** Split markdown on `## ` headings — chunks follow the author's own structure. */
function chunkMarkdown(name: string, md: string): { source: string; text: string }[] {
  return md
    .split(/^## /m)
    .map((part) => part.trim())
    .filter((part) => part.length > 40)
    .map((part) => ({ source: name, text: part.startsWith("#") ? part : `## ${part}` }));
}

/**
 * Files that are NOT retrievable knowledge.
 * brand.md is the system prompt — indexing it would let a visitor pull the
 * instructions back out through search_knowledge, and it pollutes retrieval
 * with chunks that answer nothing.
 */
const NOT_KNOWLEDGE = new Set(["brand.md"]);

/** Build the in-memory index. Called once at server boot (~seconds). */
export async function buildIndex(): Promise<number> {
  const files = (await readdir(KNOWLEDGE_DIR)).filter(
    (f) => f.endsWith(".md") && !NOT_KNOWLEDGE.has(f),
  );
  const chunks: Chunk[] = [];
  for (const file of files) {
    const md = await readFile(join(KNOWLEDGE_DIR, file), "utf8");
    for (const c of chunkMarkdown(file, md)) {
      chunks.push({ ...c, vector: await embed(c.text) });
    }
  }
  index = chunks;
  return chunks.length;
}

// --- retrieval ------------------------------------------------------------

export async function search(query: string, topK = 4): Promise<string> {
  if (!index.length) throw new Error("index not built — call buildIndex() first");
  const qv = await embed(query);
  const scored = index
    .map((c) => ({ c, score: cosine(qv, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored
    .map(({ c, score }) => `[${c.source} · ${score.toFixed(2)}]\n${c.text}`)
    .join("\n\n---\n\n");
}
