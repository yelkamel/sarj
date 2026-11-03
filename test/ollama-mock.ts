/**
 * A fake Ollama behind globalThis.fetch. Tests script the model's replies;
 * nothing ever leaves the process.
 */
import { jest } from "@jest/globals";

type Reply = { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };

/** An /api/chat streaming response: content split into NDJSON chunks, like Ollama does. */
export function chatStream(reply: Reply): Response {
  const lines: string[] = [];
  for (const word of (reply.content ?? "").split(/(?<= )/)) {
    if (word) lines.push(JSON.stringify({ message: { content: word }, done: false }));
  }
  if (reply.tool_calls) lines.push(JSON.stringify({ message: { content: "", tool_calls: reply.tool_calls }, done: false }));
  lines.push(JSON.stringify({ message: { content: "" }, done: true }));
  return new Response(lines.join("\n") + "\n");
}

export function embedResponse(vector: number[]): Response {
  return new Response(JSON.stringify({ embeddings: [vector] }));
}

export interface FakeOllama {
  /** Each /api/chat call takes the next reply (the last one repeats). */
  chat: Reply[];
  /** Maps embed input → vector. Throw to simulate a failing embed call. */
  embed: (text: string) => number[];
  chatBodies: { messages: { role: string; content: string }[] }[];
  embedCalls: number;
}

export function installFakeOllama(init: Partial<FakeOllama> = {}): FakeOllama {
  const fake: FakeOllama = { chat: [{ content: "ok" }], embed: () => [1, 0], chatBodies: [], embedCalls: 0, ...init };
  let i = 0;
  globalThis.fetch = jest.fn(async (url: string | URL | Request, opts?: RequestInit) => {
    const body = JSON.parse(String(opts?.body ?? "{}"));
    if (String(url).endsWith("/api/chat")) {
      fake.chatBodies.push(body);
      return chatStream(fake.chat[Math.min(i++, fake.chat.length - 1)]);
    }
    if (String(url).endsWith("/api/embed")) {
      fake.embedCalls++;
      try { return embedResponse(fake.embed(body.input)); }
      catch { return new Response("boom", { status: 500 }); }
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return fake;
}

export const toolCall = (name: string, args: Record<string, unknown> = {}) => ({ function: { name, arguments: args } });
