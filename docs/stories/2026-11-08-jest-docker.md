# Story: Jest unit tests + Docker packaging

**Target:** weekend of 2026-11-07/08 · **Owner:** Youcef
**Why:** the harness is measured end to end by `evals/` (it needs a live model), but nothing
tests the deterministic code on its own, and deploys depend on a hand-run VPS script.
Two gaps, one weekend.

## Part 1: Jest (unit tests, no model required)

Setup: `jest` + `ts-jest` (ESM, `"type": "module"`), or `@swc/jest`. Script `npm test`.
Mock `fetch` to Ollama: a test must never call a real model.

- [x] `harness.ts`
  - [x] language detection / per-turn pinning (FR vs EN inputs, mixed, empty)
  - [x] tool-call loop stops at **5 rounds** max (mocked model always asking for a tool)
  - [x] **1 retry** per failing tool, then graceful escalation
  - [x] event stream order: deltas → tool events → done
- [x] `rag.ts`
  - [x] markdown chunking (headings, sizes, no empty chunks)
  - [x] cosine similarity + top-K ranking on fixed fake vectors
  - [x] empty index → empty result, no crash
- [x] `tools.ts`
  - [x] `runTool` rejects names outside the allowlist
  - [x] `leave_message` validates args and writes one JSONL line (tmp dir)
- [x] `server.ts` (extract pure functions if needed)
  - [x] per-IP rate limit, session TTL expiry, CORS allowlist
- [x] Coverage report: aim for ≥ 80% on `harness.ts` and `rag.ts`
- [x] GitHub Actions: `npm test` on every push (evals stay manual, since they need Ollama)

## Part 2: Docker

- [x] `Dockerfile`: multi-stage, `node:22-alpine`, non-root user, `npm ci --omit=dev`,
      `HEALTHCHECK` on `/health`, `EXPOSE 8787`
- [x] `.dockerignore` (node_modules, .git, leads.jsonl, evals output)
- [x] `docker-compose.yml`: `sarj` + `ollama` (official image, volume for models),
      init service that pulls `$SARJ_MODEL` + `nomic-embed-text`; set `OLLAMA_URL=http://ollama:11434`
      in sarj (already read by `harness.ts` and `rag.ts`, defaults to 127.0.0.1)
- [x] Volume for `leads.jsonl` so leads survive restarts
- [x] `deploy/setup-vps.sh` → install Docker + `docker compose up -d`, keep Caddy in front
- [x] CI: build the image on push (push to GHCR optional)

## Done when
- `npm test` green locally and in CI, with no Ollama running
- `docker compose up` on a fresh machine → `curl localhost:8787/health` OK → chat answers
- `npm run eval` still passes against the composed stack
- README: "Tests" and "Run with Docker" sections, with the coverage figure
