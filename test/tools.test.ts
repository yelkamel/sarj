import { describe, expect, test, beforeEach } from "@jest/globals";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS, runTool } from "../src/tools.js";

describe("allowlist", () => {
  test("exactly the three declared tools are exposed to the model", () => {
    expect(TOOLS.map((t) => t.spec.function.name).sort()).toEqual(["get_apps", "leave_message", "search_knowledge"]);
  });

  test.each(["exec", "read_file", "fetch_url", "", "GET_APPS"])("rejects %j", async (name) => {
    await expect(runTool(name, {})).resolves.toBe(`TOOL_ERROR: unknown tool "${name}"`);
  });

  test("get_apps returns the structured catalog", async () => {
    const apps = JSON.parse(await runTool("get_apps", {}));
    expect(apps.map((a: { name: string }) => a.name)).toContain("Evolum");
  });
});

describe("leave_message", () => {
  let file: string;
  beforeEach(async () => {
    file = join(await mkdtemp(join(tmpdir(), "sarj-leads-")), "leads.jsonl");
    process.env.SARJ_LEADS_FILE = file;
  });

  test("writes one JSONL line per message", async () => {
    await expect(runTool("leave_message", { from: "ana@corp.com", message: "Job offer" })).resolves.toMatch(/recorded/);
    await runTool("leave_message", { from: "bob", message: "Hi" });

    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toEqual({ at: expect.any(String), from: "ana@corp.com", message: "Job offer" });
    expect(Number.isNaN(Date.parse(first.at))).toBe(false);
  });

  test.each([
    [{ message: "no sender" }],
    [{ from: "ana" }],
    [{ from: "  ", message: "blank sender" }],
    [{}],
  ])("rejects %j without writing", async (args) => {
    await expect(runTool("leave_message", args)).resolves.toMatch(/^TOOL_ERROR/);
    expect(existsSync(file)).toBe(false);
  });

  test("a message with newlines stays on one line", async () => {
    await runTool("leave_message", { from: "ana", message: "line1\nline2" });
    const raw = await readFile(file, "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(raw).message).toBe("line1\nline2");
  });
});
