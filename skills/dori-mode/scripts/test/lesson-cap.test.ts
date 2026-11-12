import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { GLOBAL_LESSON_CAP, Lessons } from "../src/lessons.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const T0 = Date.parse("2026-10-29T00:00:00Z");

test("forRepo adds a cap warning to problems when active global lessons exceed GLOBAL_LESSON_CAP", () => {
  const state = withState();
  try {
    const lessons = new Lessons(state.dir);
    const input = { lane: "lead", scope: "global" as const, rule: "Rule", evidence: "ref" };
    // Add exactly cap lessons — no warning.
    for (let i = 0; i < GLOBAL_LESSON_CAP; i++) lessons.add({ ...input, rule: `Rule ${i}` }, T0 + i);
    const atCap = lessons.forRepo("/tmp");
    expect(atCap.problems).toEqual([]);
    expect(atCap.lessons).toHaveLength(GLOBAL_LESSON_CAP);
    // Add one more — warning appears naming the 1 dropped lesson.
    lessons.add({ ...input, rule: "One over" }, T0 + GLOBAL_LESSON_CAP);
    const over = lessons.forRepo("/tmp");
    expect(over.problems).toHaveLength(1);
    expect(over.problems[0]).toContain("1 global lesson left out of brief");
    expect(over.problems[0]).toContain(`cap ${GLOBAL_LESSON_CAP}`);
    expect(over.problems[0]).toContain("lesson mark <id> --outcome encoded");
    // The cap is still respected — only GLOBAL_LESSON_CAP lessons are returned.
    expect(over.lessons).toHaveLength(GLOBAL_LESSON_CAP);
    // Two over — plural form.
    lessons.add({ ...input, rule: "Two over" }, T0 + GLOBAL_LESSON_CAP + 1);
    const twoOver = lessons.forRepo("/tmp");
    expect(twoOver.problems[0]).toContain("2 global lessons left out of brief");
  } finally {
    state.done();
  }
});

test("dori lesson add --global prints LESSON_CAP_WARNING on stderr when cap exceeded", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const invoke = (...args: string[]) =>
      run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, ...args]);
    // Fill up to cap — no warning on stderr.
    for (let i = 0; i < GLOBAL_LESSON_CAP; i++) {
      const r = await invoke("lesson", "add", "--global", "--rule", `Rule ${i}`, "--evidence", "ref");
      expect([r.code, r.err]).toEqual([0, ""]);
    }
    // One more — LESSON_CAP_WARNING on stderr; exit still 0.
    const over = await invoke("lesson", "add", "--global", "--rule", "Over cap", "--evidence", "ref");
    expect(over.code).toBe(0);
    expect(over.err).toContain("LESSON_CAP_WARNING");
    expect(over.err).toContain("1 global lesson left out of brief");
    expect(over.err).toContain("lesson mark <id> --outcome encoded");
  } finally {
    state.done();
  }
});
