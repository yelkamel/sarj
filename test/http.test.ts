import { describe, expect, test } from "@jest/globals";
import { clientIp, corsOrigin, createRateLimiter, createSessionStore } from "../src/http.js";

describe("rate limit", () => {
  test("20 per minute per IP, the 21st is refused", () => {
    const limited = createRateLimiter(20, 60_000);
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) expect(limited("1.1.1.1", t)).toBe(false);
    expect(limited("1.1.1.1", t)).toBe(true);
  });

  test("IPs are counted separately", () => {
    const limited = createRateLimiter(1, 60_000);
    expect(limited("a", 0)).toBe(false);
    expect(limited("a", 0)).toBe(true);
    expect(limited("b", 0)).toBe(false);
  });

  test("the window resets", () => {
    const limited = createRateLimiter(1, 60_000);
    expect(limited("a", 0)).toBe(false);
    expect(limited("a", 60_000)).toBe(true); // still inside the window
    expect(limited("a", 60_001)).toBe(false);
  });
});

describe("clientIp", () => {
  test("a spoofed X-Forwarded-For can't pick the bucket: the proxy's last entry wins", () => {
    expect(clientIp("6.6.6.6, 203.0.113.7", "172.18.0.1")).toBe("203.0.113.7");
  });
  test("single entry", () => {
    expect(clientIp("203.0.113.7", "172.18.0.1")).toBe("203.0.113.7");
  });
  test("no proxy → socket address", () => {
    expect(clientIp(undefined, "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIp("", undefined)).toBe("?");
  });
  test("repeated headers are joined", () => {
    expect(clientIp(["1.1.1.1", "2.2.2.2"], undefined)).toBe("2.2.2.2");
  });
});

describe("rate limit memory", () => {
  test("the cleanup of expired buckets keeps the live ones", () => {
    const limited = createRateLimiter(1, 1000);
    for (let i = 0; i <= 10_000; i++) limited(`old${i}`, 0); // all expire at t=1000
    expect(limited("live", 4900)).toBe(false); // map is large → cleanup runs here
    expect(limited("live", 4950)).toBe(true); // live bucket survived, still counted
  });
});

describe("sessions", () => {
  const TTL = 30 * 60_000;

  test("a new session starts with the system prompt", () => {
    const store = createSessionStore(TTL, () => "PROMPT");
    expect(store.get("s1", 0).history).toEqual([{ role: "system", content: "PROMPT" }]);
  });

  test("same id → same session", () => {
    const store = createSessionStore(TTL, () => "P");
    const a = store.get("s1", 0);
    a.history.push({ role: "user", content: "hi" });
    expect(store.get("s1", 10).history).toHaveLength(2);
    expect(store.size).toBe(1);
  });

  test("expires after the TTL of inactivity", () => {
    const store = createSessionStore(TTL, () => "P");
    store.get("idle", 0);
    store.sweep(TTL); // exactly TTL: kept
    expect(store.size).toBe(1);
    store.sweep(TTL + 1);
    expect(store.size).toBe(0);
  });

  test("activity pushes the expiry back", () => {
    const store = createSessionStore(TTL, () => "P");
    store.get("busy", 0);
    store.get("busy", TTL - 1);
    store.sweep(TTL + 1);
    expect(store.size).toBe(1);
  });
});

describe("CORS", () => {
  const allowed = ["http://localhost:4321", "https://youcefelkamel.com"];
  test("echoes an allowlisted origin", () => {
    expect(corsOrigin("https://youcefelkamel.com", allowed)).toBe("https://youcefelkamel.com");
  });
  test.each(["https://evil.com", "", "https://youcefelkamel.com.evil.com"])("never echoes %j", (o) => {
    expect(corsOrigin(o, allowed)).toBe("http://localhost:4321");
  });
});
