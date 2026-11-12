import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { EVAL_BATCHING, isSol, withEvalBatching } from "../eval-batching";
import { load, useConfig } from "./fake-pi";

const SOL = { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
const base = { type: "before_agent_start", prompt: "fix it", systemPrompt: ["base prompt"] };

beforeEach(() => {
  useConfig(join(import.meta.dir, "fake-ulw.ts"));
});

const roleSession = async (role: string | undefined, model = SOL, active = ["read", "bash", "eval"]) => {
  const pi = await load({
    session: { id: `s-${role}`, entries: [] },
    flags: role ? { "dori-role": role } : {},
    model,
    active,
  });
  await pi.emit("session_start");
  return pi;
};

describe("eval batching", () => {
  test("a Dori role session on Sol with eval gets the batching block after the base prompt", async () => {
    for (const role of ["dori", "lane"]) {
      const [own] = await (await roleSession(role)).emit("before_agent_start", base);
      expect(own).toEqual({ systemPrompt: ["base prompt", EVAL_BATCHING] });
    }
  });

  test("plain sessions, other models and sessions without eval keep their prompt", async () => {
    expect((await (await roleSession(undefined)).emit("before_agent_start", base))[0]).toBeUndefined();
    const opus = await roleSession("lane", { id: "claude-opus-5-5", name: "Claude Opus 5.5" });
    expect((await opus.emit("before_agent_start", base))[0]).toBeUndefined();
    const terra = await roleSession("lane", { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" });
    expect((await terra.emit("before_agent_start", base))[0]).toBeUndefined();
    const noEval = await roleSession("lane", SOL, ["read", "bash"]);
    expect((await noEval.emit("before_agent_start", base))[0]).toBeUndefined();
  });

  test("Sol is recognised across provider prefixes, separators and display names only", () => {
    for (const id of ["gpt-6.1-sol", "openai-codex/gpt-6.1-sol", "gpt-61-sol", "gpt_6_1_sol-fast", "GPT-6-1-SOL"])
      expect(isSol({ id })).toBe(true);
    expect(isSol({ id: "custom-alias", name: "GPT-6.1 Sol" })).toBe(true);
    for (const id of ["gpt-6-sol", "gpt-6.1-solar", "gpt-6.1-terra", "gpt-16.1-sol", "consol-gpt-6.1"])
      expect(isSol({ id })).toBe(false);
    expect(isSol(undefined)).toBe(false);
  });

  test("a prompt that already carries the block, or is not a block list, is left alone", () => {
    expect(withEvalBatching(["base", EVAL_BATCHING], SOL, ["eval"])).toBeUndefined();
    expect(withEvalBatching("base", SOL, ["eval"])).toBeUndefined();
    expect(withEvalBatching(["base", 1], SOL, ["eval"])).toBeUndefined();
  });
});
