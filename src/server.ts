/**
 * HTTP server — node:http, no Express.
 *
 * POST /chat  { sessionId, message }  →  Server-Sent Events stream
 *   event: token       (text delta)
 *   event: tool_start  (tool name — lets the UI show "searching…")
 *   event: tool_end
 *   event: done        (full final answer)
 *   event: error
 *
 * Sessions live in memory with a TTL — a personal-site chat does not need
 * Redis. Restart = fresh sessions, and that is fine.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Message, runTurn, MODEL } from "./harness.js";
import { buildIndex } from "./rag.js";

const PORT = Number(process.env.PORT ?? 8787);
const ALLOWED_ORIGINS = (process.env.SARJ_ORIGINS ?? "http://localhost:4321,https://youcefelkamel.com,https://www.youcefelkamel.com").split(",");
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGE_LEN = 2000;
const MAX_HISTORY = 40; // messages kept per session (sliding window)

// --- system prompt: identity + brand tone, loaded from the knowledge base --

const SYSTEM_PROMPT_FILE = new URL("../knowledge/brand.md", import.meta.url).pathname;
let systemPrompt = "";

// --- sessions --------------------------------------------------------------

interface Session { history: Message[]; touched: number }
const sessions = new Map<string, Session>();

function getSession(id: string): Session {
  const existing = sessions.get(id);
  if (existing) { existing.touched = Date.now(); return existing; }
  const fresh: Session = { history: [{ role: "system", content: systemPrompt }], touched: Date.now() };
  sessions.set(id, fresh);
  return fresh;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
}, 60_000).unref();

// --- rate limiting: naive token bucket per IP — enough for a personal site -

const buckets = new Map<string, { count: number; reset: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.reset) { buckets.set(ip, { count: 1, reset: now + 60_000 }); return false; }
  b.count++;
  return b.count > 20; // 20 messages / min / IP
}

// --- server ----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const origin = req.headers.origin ?? "";
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("access-control-allow-origin", corsOrigin);
  res.setHeader("access-control-allow-headers", "content-type");

  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: MODEL, sessions: sessions.size }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/chat") { res.writeHead(404).end(); return; }

  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?");
  if (rateLimited(ip)) { res.writeHead(429).end("slow down"); return; }

  // Read + validate body
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) { res.writeHead(413).end(); return; }
  }
  let sessionId: string, message: string;
  try {
    const parsed = JSON.parse(body);
    sessionId = String(parsed.sessionId ?? "");
    message = String(parsed.message ?? "").slice(0, MAX_MESSAGE_LEN).trim();
    if (!sessionId || !message) throw new Error("missing fields");
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }

  // SSE stream
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: string, data: string) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const session = getSession(sessionId);
  // Sliding window: keep system prompt + last N messages
  if (session.history.length > MAX_HISTORY) {
    session.history = [session.history[0], ...session.history.slice(-MAX_HISTORY)];
  }

  const abort = new AbortController();
  req.on("close", () => abort.abort());

  try {
    for await (const ev of runTurn(session.history, message, abort.signal)) {
      send(ev.type, ev.data);
    }
  } catch (err) {
    send("error", String(err));
  }
  res.end();
});

// --- boot: load prompt, build RAG index, listen ----------------------------

systemPrompt = await readFile(SYSTEM_PROMPT_FILE, "utf8");
const chunkCount = await buildIndex();
server.listen(PORT, () => {
  console.log(`sarj up on :${PORT} · model=${MODEL} · rag=${chunkCount} chunks`);
});
