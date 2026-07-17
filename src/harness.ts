/**
 * Sarj — the harness. This file IS the product.
 *
 * A harness is the machinery around a model that turns "text in, text out"
 * into an agent: it owns the conversation state, decides when the model may
 * call a tool, executes that tool, feeds the result back, and loops until
 * the model produces a final answer for the user.
 *
 * No framework, no SDK. One loop you can read top to bottom.
 */

import { TOOLS, runTool } from "./tools.js";

// ---------------------------------------------------------------------------
// Types — the shape of a conversation, kept deliberately minimal.
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface Message {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string; // set on role:"tool" messages, for traceability
}

export interface HarnessEvent {
  type: "token" | "tool_start" | "tool_end" | "done" | "error";
  data: string;
}

// ---------------------------------------------------------------------------
// Model client — a plain HTTP call to a local model served by Ollama.
// Swapping providers means rewriting ~30 lines, not learning a framework.
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
export const MODEL = process.env.SARJ_MODEL ?? "qwen2.5:7b-instruct";

interface ChatChunk {
  message?: { content?: string; tool_calls?: ToolCall[] };
  done?: boolean;
}

/**
 * One streaming model call. Yields text tokens as they arrive; returns the
 * full assistant message (content + any tool calls) once the stream ends.
 */
async function* callModel(
  messages: Message[],
  signal?: AbortSignal,
): AsyncGenerator<string, Message> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS.map((t) => t.spec),
      stream: true,
      options: { temperature: 0.3, num_ctx: 8192 },
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`model call failed: ${res.status} ${await res.text()}`);
  }

  const assistant: Message = { role: "assistant", content: "" };
  const decoder = new TextDecoder();
  let buffer = "";

  // Ollama streams newline-delimited JSON chunks.
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const parsed = JSON.parse(line) as ChatChunk;
      const token = parsed.message?.content ?? "";
      if (token) {
        assistant.content += token;
        yield token;
      }
      if (parsed.message?.tool_calls?.length) {
        assistant.tool_calls = [
          ...(assistant.tool_calls ?? []),
          ...parsed.message.tool_calls,
        ];
      }
    }
  }
  return assistant;
}

// ---------------------------------------------------------------------------
// Deterministic language pinning.
//
// Asking the model to "detect the visitor's language and mirror it" works ~90%
// of the time — it drifted to French on English questions whenever retrieval
// came back empty. Language is cheap to detect in code, so the harness decides
// it and tells the model, every turn. Don't ask a model to do what a regex can
// do reliably: that choice is exactly what owning the loop buys you.
// ---------------------------------------------------------------------------

const FR_HINTS = /\b(le|la|les|est|une|des|pas|je|vous|quoi|qui|quel|quelle|comment|pourquoi|c'est|ses|son|sur|avec|pour)\b/gi;
const EN_HINTS = /\b(the|is|are|and|of|to|for|with|his|you|what|who|which|how|why|does|has|can)\b/gi;

function detectLang(text: string): "fr" | "en" {
  const fr = (text.match(FR_HINTS) ?? []).length;
  const en = (text.match(EN_HINTS) ?? []).length;
  return fr > en ? "fr" : "en"; // ties → English (the knowledge base's language)
}

const LANG_PIN: Record<"fr" | "en", string> = {
  fr: "The visitor is writing in FRENCH. Your entire reply MUST be in French — translate any English source material you retrieve. Do not use English.",
  en: "The visitor is writing in ENGLISH. Your entire reply MUST be in English. Do not use French.",
};

// ---------------------------------------------------------------------------
// The loop — the heart of the harness.
//
//   user msg → model → (tool calls? execute → feed back → model again) → answer
//
// Hard limits everywhere: max tool rounds, one retry per failing tool, and a
// graceful escalation when something is beyond the agent. An agent without
// limits is not autonomous, it is unsupervised.
// ---------------------------------------------------------------------------

const MAX_TOOL_ROUNDS = 5;

export async function* runTurn(
  history: Message[],
  userText: string,
  signal?: AbortSignal,
): AsyncGenerator<HarnessEvent> {
  history.push({ role: "user", content: userText });

  // Pinned once per turn, kept OUT of history: it reflects this message's
  // language, not the conversation's, and it must sit last for recency.
  const langPin: Message = { role: "system", content: LANG_PIN[detectLang(userText)] };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // 1. Ask the model, streaming tokens out as they come.
    let assistant: Message;
    try {
      const gen = callModel([...history, langPin], signal);
      let next = await gen.next();
      while (!next.done) {
        yield { type: "token", data: next.value };
        next = await gen.next();
      }
      assistant = next.value;
    } catch (err) {
      yield { type: "error", data: String(err) };
      return;
    }
    history.push(assistant);

    // 2. No tool calls → the model answered the user. Turn over.
    if (!assistant.tool_calls?.length) {
      yield { type: "done", data: assistant.content };
      return;
    }

    // 3. Execute each requested tool and append results to the transcript.
    for (const call of assistant.tool_calls) {
      const { name, arguments: args } = call.function;
      yield { type: "tool_start", data: name };

      let result: string;
      try {
        result = await runTool(name, args);
      } catch {
        // One retry, then hand the failure to the model so it can adapt
        // (apologize, try another tool, or escalate) instead of crashing.
        try {
          result = await runTool(name, args);
        } catch (err2) {
          result = `TOOL_ERROR: ${String(err2)}`;
        }
      }

      history.push({ role: "tool", tool_name: name, content: result });
      yield { type: "tool_end", data: name };
    }
    // Loop: the model now sees the tool results and speaks again.
  }

  // Tool-call budget exhausted — never leave the user hanging.
  const fallback =
    "Je n'arrive pas à finaliser cette demande — je préfère être honnête. " +
    "Écris directement à Youcef : yelkamel@gmail.com";
  history.push({ role: "assistant", content: fallback });
  yield { type: "done", data: fallback };
}
