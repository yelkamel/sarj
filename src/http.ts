/**
 * The server's policy, kept free of I/O so it can be tested without a socket:
 * per-IP rate limiting, session TTL, CORS allowlist. server.ts wires these up.
 */

import type { Message } from "./harness.js";

// --- rate limiting: naive fixed window per IP — enough for a personal site --

export function createRateLimiter(limit = 20, windowMs = 60_000) {
  const buckets = new Map<string, { count: number; reset: number }>();
  return function rateLimited(ip: string, now = Date.now()): boolean {
    // Drop expired buckets once the map grows, so one-off IPs don't pile up forever.
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
    const b = buckets.get(ip);
    if (!b || now > b.reset) { buckets.set(ip, { count: 1, reset: now + windowMs }); return false; }
    b.count++;
    return b.count > limit;
  };
}

/**
 * The client IP behind one trusted reverse proxy (Caddy). The proxy APPENDS the
 * real peer to X-Forwarded-For, so only the last entry is trustworthy: the first
 * one is whatever the client typed, and keying on it lets anyone dodge the limit.
 */
export function clientIp(forwardedFor: string | string[] | undefined, remoteAddress?: string): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "";
  const last = header.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last ?? remoteAddress ?? "?";
}

// --- sessions: in memory, with a TTL — a personal-site chat does not need Redis

export interface Session { history: Message[]; touched: number }

export function createSessionStore(ttlMs: number, systemPrompt: () => string) {
  const sessions = new Map<string, Session>();
  return {
    get(id: string, now = Date.now()): Session {
      const existing = sessions.get(id);
      if (existing) { existing.touched = now; return existing; }
      const fresh: Session = { history: [{ role: "system", content: systemPrompt() }], touched: now };
      sessions.set(id, fresh);
      return fresh;
    },
    sweep(now = Date.now()): void {
      for (const [id, s] of sessions) if (now - s.touched > ttlMs) sessions.delete(id);
    },
    get size() { return sessions.size; },
  };
}

// --- CORS: echo the origin only if allowlisted, otherwise the first allowed one

export function corsOrigin(origin: string, allowed: string[]): string {
  return allowed.includes(origin) ? origin : allowed[0];
}
