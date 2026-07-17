/**
 * Tools — what the agent is ALLOWED to do, and nothing else.
 *
 * Each tool = a JSON spec the model sees + a handler the harness executes.
 * The allowlist is the security model: the model can only reach what is
 * declared here, with the arguments validated here.
 */

import { appendFile } from "node:fs/promises";
import { search } from "./rag.js";

interface Tool {
  spec: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: {
        type: "object";
        properties: Record<string, { type: string; description: string }>;
        required: string[];
      };
    };
  };
  handler: (args: Record<string, unknown>) => Promise<string>;
}

// --- 1. Knowledge search (RAG) -------------------------------------------

const searchKnowledge: Tool = {
  spec: {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "Search Youcef's knowledge base (bio, experience, products, skills, availability). " +
        "Use this BEFORE answering any factual question about Youcef.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in natural language" },
        },
        required: ["query"],
      },
    },
  },
  handler: async (args) => search(String(args.query ?? "")),
};

// --- 2. Product catalog (structured, not RAG — exact data stays exact) ----

const APPS = [
  { name: "Evolum", domain: "meditation & personal growth", stats: "100k+ users · 4.9★ · 7 years, bootstrapped", role: "solo founder, CTO & product" },
  { name: "BeeDone", domain: "gamified productivity", stats: "Top 5 Product Hunt", role: "solo founder" },
  { name: "UpDrive", domain: "VTC / driver tools", stats: "shipped end-to-end", role: "solo founder" },
  { name: "Strive", domain: "social goals", stats: "shipped end-to-end", role: "solo founder" },
  { name: "Muse Otter", domain: "creative companion", stats: "in store launch phase", role: "solo founder" },
];

const getApps: Tool = {
  spec: {
    type: "function",
    function: {
      name: "get_apps",
      description: "Exact list of apps Youcef built, with stats and his role. Use for any product question.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  handler: async () => JSON.stringify(APPS, null, 2),
};

// --- 3. Leave a message → becomes a lead in leads.jsonl -------------------

const LEADS_FILE = new URL("../leads.jsonl", import.meta.url).pathname;

const leaveMessage: Tool = {
  spec: {
    type: "function",
    function: {
      name: "leave_message",
      description:
        "Record a message for Youcef (collaboration, job offer, question the agent cannot answer). " +
        "Always ask the visitor for their email or contact before calling this.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Visitor's name or email" },
          message: { type: "string", description: "The message for Youcef" },
        },
        required: ["from", "message"],
      },
    },
  },
  handler: async (args) => {
    const entry = { at: new Date().toISOString(), from: String(args.from ?? "?"), message: String(args.message ?? "") };
    await appendFile(LEADS_FILE, JSON.stringify(entry) + "\n");
    return "Message recorded. Youcef reads these daily.";
  },
};

// --- registry -------------------------------------------------------------

export const TOOLS: Tool[] = [searchKnowledge, getApps, leaveMessage];

export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = TOOLS.find((t) => t.spec.function.name === name);
  if (!tool) return `TOOL_ERROR: unknown tool "${name}"`; // model hallucinated a tool — tell it, don't crash
  return tool.handler(args ?? {});
}
