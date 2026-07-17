# Sarj (سرج)

> A custom agent harness, written from scratch. No agent framework, no SDK —
> one loop, tools, from-scratch RAG, a local LLM. Live as the support chat on
> [youcefelkamel.com](https://youcefelkamel.com).

## Why

In a technical interview, I was asked to design a customer-support agent on a
**custom harness** with a **local model** — and I answered with my deployed
open-source stack instead. Fair flag: I had never written the harness layer
myself. So I did, over a weekend, and put it in production on my own site.

A harness is everything around the model that makes it an agent: conversation
state, the tool-call loop, execution, limits, and recovery. That's ~150 lines
in [`src/harness.ts`](src/harness.ts) — the file to read.

## Architecture

```
browser bubble ──POST /chat (SSE)──▶ server.ts ──▶ harness.ts ──▶ Ollama (local LLM)
                                        │              │
                                   sessions        tools.ts ──▶ rag.ts (from-scratch RAG)
                                   rate-limit                 ──▶ get_apps (structured)
                                                              ──▶ leave_message → leads.jsonl
```

- **`src/harness.ts`** — the loop: model → tool calls → execute → feed back →
  loop. Hard limits (max 5 tool rounds, 1 retry per failing tool), graceful
  escalation, streaming all the way through.
- **`src/tools.ts`** — the allowlist. The model only reaches what's declared here.
- **`src/rag.ts`** — retrieval with zero infrastructure: markdown → chunks →
  local embeddings → in-memory cosine similarity. Right-sized for a corpus of
  dozens of chunks; a vector DB here would be résumé-driven engineering.
- **`src/server.ts`** — node:http + SSE. Sessions in memory with TTL, naive
  per-IP rate limiting, CORS allowlist.
- **`evals/`** — 13 scenarios asserted on every change: facts, language
  mirroring, off-topic refusal, hallucination traps, a prompt-leak probe, and a
  confidentiality guardrail (the agent must not name a former employer, so a
  scenario actively tries to make it). An unmeasured agent is just a vibe.

## Model choice — measured, not guessed

The eval suite is how the model got picked. Every number is `npm run eval`.
**v4 is averaged over 3 runs per model** — single runs of a 12-scenario suite at
temperature 0.3 swing by a full scenario or two, so one run is an anecdote.

| Build | 3B | 7B |
|---|---|---|
| v1 — naive prompt | 67% | — |
| v2 — hardened prompt (leak + refusal + language rules) | 67% | 92%¹ |
| v3 — facts moved out of the prompt into RAG | 67% | 83%¹ |
| **v4 — deterministic language pinning in the harness** | **81%** | **94%** |

<sub>¹ single run — the variance problem I hadn't noticed yet.</sub>

**Two findings, one of which I got wrong first.**

Most 3B failures at v3 were language drift: it answered English questions in French
whenever retrieval came back empty. That's not a reasoning failure, and a bigger
model is an expensive way to paper over it. Detecting the language in code and
pinning it per turn ([`harness.ts`](src/harness.ts)) lifted the 3B from 67% → 81%.
Real gain, free, from the harness rather than the model.

Then I got excited: one 3B run scored 92% and I wrote down "the 3B matches the 7B,
ship the small one." Three runs each says otherwise — 81% vs 94%. The lesson is the
one this whole repo is about: **a single measurement is not a measurement.** The
language fix was real; the "free lunch" was noise.

**Chosen: Qwen2.5 7B Instruct.** The 13-point gap is worth the RAM for an agent that
speaks to recruiters about me — being slow beats being wrong. The 3B stays one env
var away (`SARJ_MODEL`) for cheap-CPU deployments where latency dominates.

| Model | Size (q4) | Tool calling | Verdict |
|---|---|---|---|
| **Qwen2.5 7B Instruct** | ~4.7 GB | reliable | **chosen** — 94% over 3 runs |
| Qwen2.5 3B Instruct | ~1.9 GB | acceptable | 81% — the CPU-only / low-latency fallback |
| Llama 3.1 8B Instruct | ~4.9 GB | good | weaker French |
| Mistral 7B v0.3 | ~4.4 GB | irregular | tool-call format too loose |

### Cost / latency / quality — the actual tradeoff

| Deployment | ~Cost/month | Latency | Quality |
|---|---|---|---|
| CPU VPS + 3B | ~5€ | ~2-4s | 81% |
| CPU VPS + 7B | ~10-15€ | ~10-20s | 94% |
| GPU VPS + 7B | ~50-200€ | <2s | 94% |

Live deployment is **CPU + 7B**: on a personal site with single-digit daily
conversations, a GPU is absurd and 15s with a visible "thinking" state is an
honest trade. The right answer moves with traffic — at hundreds of conversations
a day, the GPU box amortizes and the calculus flips.

Embeddings: `nomic-embed-text` (137M) — small, fast, local.
Serving: [Ollama](https://ollama.com) — one binary, an HTTP API, GGUF quantization
built in. Swapping to vLLM on a GPU box changes nothing in the harness: it only
knows an HTTP endpoint.

## What the evals caught (the actual engineering)

The suite paid for itself immediately — every one of these was a real bug found by
a failing scenario, not by reading the code:

- **The system prompt was retrievable.** `brand.md` lived in the knowledge folder,
  so it got indexed — a visitor could pull the instructions back out through
  `search_knowledge`. Now explicitly excluded ([`rag.ts`](src/rag.ts)).
- **Facts in the prompt beat facts in RAG.** The model answered "10 years" from the
  system prompt without ever searching. Removing every fact from the prompt forced
  real retrieval — and made hallucination testable.
- **Retrieval collisions are a chunking problem.** Adding a Dubai section that said
  "for two years" hijacked "how many *years* of experience" — same surface form,
  different question. Fixed in the corpus, not the model.
- **Language drift, fixed in the loop** — see above.
- **One failure was the test's fault.** A scenario asserted English words in the
  answer; the agent replied correctly in French and "failed". The fix was to assert
  language explicitly and stop smuggling a language check into a content check.

## Run it

```bash
ollama pull qwen2.5:7b-instruct && ollama pull nomic-embed-text
npm install
npm run chat   # terminal REPL
npm run dev    # HTTP server on :8787
npm run eval   # the 13 scenarios
```

Env: `SARJ_MODEL`, `SARJ_EMBED_MODEL`, `OLLAMA_URL`, `PORT`, `SARJ_ORIGINS`.

## Deploy (how the live one runs)

Small VPS (CPU-only is fine with the 3B model), Ollama + `npm start` behind a
reverse proxy for TLS. `deploy/setup-vps.sh` goes from bare Ubuntu to running
service. Monthly cost: single-digit euros.

## What I'd do with two more weeks

- LLM-as-judge eval layer on top of the string assertions
- Structured extraction of leads (name/company/intent) instead of free text
- Conversation summarization instead of the sliding window
- A/B on system prompts, measured by escalation rate
