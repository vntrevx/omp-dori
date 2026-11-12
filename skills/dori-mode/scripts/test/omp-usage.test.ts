import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sumUsageFromJsonl } from "../src/omp-usage.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

// ── unit tests: sumUsageFromJsonl ─────────────────────────────────────────────

const assistantLine = (totalTokens: number, costTotal: number): string =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", usage: { totalTokens, cost: { total: costTotal } } },
  });

const modelUsageLine = (totalTokens: number, costTotal: number): string =>
  JSON.stringify({
    type: "model_usage",
    usage: { totalTokens, cost: { total: costTotal } },
  });

test("sums totalTokens and costUsd from assistant messages and model_usage entries", () => {
  const content = [
    JSON.stringify({ type: "session", id: "abc" }),
    assistantLine(1000, 0.01),
    modelUsageLine(500, 0.005),
    assistantLine(2000, 0.02),
    "",
  ].join("\n");
  const r = sumUsageFromJsonl(content);
  expect(r.tokens).toBe(3500);
  expect(r.costUsd).toBeCloseTo(0.035);
});

test("skips user messages — only assistant role contributes", () => {
  const content = [
    JSON.stringify({ type: "message", message: { role: "user", usage: { totalTokens: 999, cost: { total: 9 } } } }),
    assistantLine(100, 0.001),
    "",
  ].join("\n");
  expect(sumUsageFromJsonl(content).tokens).toBe(100);
});

test("skips torn last line without failing the whole read", () => {
  const content = [assistantLine(300, 0.003), '{"type":"model_usage","usage":{"totalTokens":'].join("\n");
  // Last line is torn (incomplete JSON) — should not throw, should sum only the first line.
  const r = sumUsageFromJsonl(content);
  expect(r.tokens).toBe(300);
  expect(r.costUsd).toBeCloseTo(0.003);
});

test("skips intermediate malformed lines and continues", () => {
  const content = [assistantLine(200, 0.002), "not-json-at-all", assistantLine(100, 0.001), ""].join("\n");
  expect(sumUsageFromJsonl(content).tokens).toBe(300);
});

test("returns zeros for a session with no usage entries", () => {
  const content = [JSON.stringify({ type: "session", id: "x" }), JSON.stringify({ type: "model_change" }), ""].join(
    "\n",
  );
  expect(sumUsageFromJsonl(content)).toEqual({ tokens: 0, costUsd: 0 });
});

// ── subprocess tests: CLI wiring ─────────────────────────────────────────────

const mkSessions = (dir: string, sessionId: string, lines: string[]): string => {
  const sub = join(dir, "--cwd--");
  mkdirSync(sub, { recursive: true });
  const file = join(sub, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return dir;
};

test("dori usage omp --session prints JSON with summed tokens and cost", async () => {
  const state = withState();
  try {
    const sessionsDir = join(state.dir, "sessions");
    const id = "aaaabbbb-0000-0000-0000-000000000001";
    mkSessions(sessionsDir, id, [
      JSON.stringify({ type: "session", id }),
      assistantLine(1500, 0.015),
      modelUsageLine(300, 0.003),
    ]);
    const cfg = join(state.dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ stateDir: state.dir, sessionsDir, defaultCwd: state.dir, hooks: {} }));
    const r = await run(["env", `DORI_CONFIG=${cfg}`, process.execPath, cli, "usage", "omp", "--session", id], {
      timeoutMs: 20_000,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out.trim()) as { tokens: number; costUsd: number };
    expect(parsed.tokens).toBe(1800);
    expect(parsed.costUsd).toBeCloseTo(0.018);
  } finally {
    state.done();
  }
}, 30_000);

test("dori usage omp --session exits nonzero for unknown session", async () => {
  const state = withState();
  try {
    const sessionsDir = join(state.dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const cfg = join(state.dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ stateDir: state.dir, sessionsDir, defaultCwd: state.dir, hooks: {} }));
    const r = await run(
      ["env", `DORI_CONFIG=${cfg}`, process.execPath, cli, "usage", "omp", "--session", "no-such-session"],
      { timeoutMs: 20_000 },
    );
    expect(r.code).not.toBe(0);
    expect(r.err.length).toBeGreaterThan(0);
  } finally {
    state.done();
  }
}, 30_000);
