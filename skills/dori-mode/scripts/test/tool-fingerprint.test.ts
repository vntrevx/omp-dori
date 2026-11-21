import { describe, expect, test } from "bun:test";
import { resultFingerprint } from "../src/tool-fingerprint.ts";

// Text layouts of OMP 18.20.0 (kept in 19.0.1 except the spill URL, below): bash #buildCompletedResult puts the wall time first among its notices
// (`out`, "", wall time, notices...), and formatOutputNotice appends `\n\n[...]` citing the artifact in details.meta.
const busy = "Ran in a copy of the busy session shell; changes here won't persist.";
const clamp = "Timeout clamped to 3600 seconds.";
const print = (text: string, details: Record<string, unknown>, name = "bash") =>
  resultFingerprint(name, [{ type: "text", text }], details);
const timed = { wallTimeNoticeEmitted: true, wallTimeMs: 1500 };
const quick = { wallTimeNoticeEmitted: false, wallTimeMs: 400 };

describe("native wall time", () => {
  test.each([
    [`out\n\nWall time: 1.50 seconds\n${busy}`, `out\n\n${busy}`],
    [`out\n\nWall time: 1.50 seconds\n${clamp}\n${busy}`, `out\n\n${clamp}\n${busy}`],
    ["out\n\nWall time: 1.50 seconds\n\n[Showing lines 1-2 of 2]", "out\n\n[Showing lines 1-2 of 2]"],
    ["out\n\nWall time: 1.50 seconds", "out"],
  ])("a wall time before other notices is timing: %j", (slow, fast) => {
    expect(print(slow, timed)).toBe(print(fast, quick));
  });

  test("the notices after a wall time, and output that reads like one, stay data", () => {
    expect(print(`out\n\nWall time: 1.50 seconds\n${busy}`, timed)).not.toBe(print("out", quick));
    expect(print(`out\n\nWall time: 1.50 seconds\n${clamp}`, timed)).not.toBe(print(`out\n\n${busy}`, quick));
    expect(print("Wall time: 2.00 seconds\n\nWall time: 1.50 seconds", timed)).not.toBe(
      print("Wall time: 9.00 seconds\n\nWall time: 1.50 seconds", timed),
    );
    // Not emitted, or not the wall time the details record: the command's own output.
    const unflagged = { wallTimeNoticeEmitted: false, wallTimeMs: 1500 };
    expect(print("out\n\nWall time: 1.50 seconds", unflagged)).not.toBe(print("out", unflagged));
    expect(print("out\n\nWall time: 7.00 seconds", timed)).not.toBe(print("out", quick));
    expect(print("out\n\nWall time: 1.50 seconds is data", timed)).not.toBe(print("out is data", quick));
    expect(print("out  \n\n", quick)).not.toBe(print("out", quick));
  });
});

test("Bash timeout settings are bookkeeping, while timeout-named result data stays evidence", () => {
  const first = { timeoutSeconds: 30, requestedTimeoutSeconds: 30, timeoutDisabled: false };
  const second = { timeoutSeconds: 0, requestedTimeoutSeconds: 0, timeoutDisabled: true };
  expect(print("same", first)).toBe(print("same", second));
  expect(print("same", first, "read")).not.toBe(print("same", second, "read"));
  expect(print("same", { result: first })).not.toBe(print("same", { result: second }));
});

describe("native artifact locators", () => {
  const truncated = (id: string, totalLines = 50) => ({
    meta: { truncation: { direction: "tail", totalLines, outputLines: 10, artifactId: id } },
  });
  const notice = (id: string) => `[Showing lines 41-50 of 50. Read artifact://${id} for full output]`;
  const minimized = (id: string) => ({
    meta: { minimized: { filter: "git", inputBytes: 9, outputBytes: 3, artifactId: id } },
  });

  test("the locator the metadata names is not evidence; the truncation data is", () => {
    expect(print(`tail\n\n${notice("3")}`, truncated("3"))).toBe(print(`tail\n\n${notice("9")}`, truncated("9")));
    expect(print(`tail\n\n${notice("3")}`, truncated("3"))).not.toBe(
      print(`tail\n\n${notice("9")}`, truncated("9", 51)),
    );
    expect(print(`tail\n\n${notice("3")}`, truncated("3"))).not.toBe(print(`other\n\n${notice("9")}`, truncated("9")));
    expect(print("ok\n[raw output: artifact://4]", minimized("4"))).toBe(
      print("ok\n[raw output: artifact://8]", minimized("8")),
    );
  });

  test("a minimized footer remains a native locator before Bash notices", () => {
    const details = (id: string) => ({
      ...minimized(id),
      ...timed,
      timeoutSeconds: 3600,
      requestedTimeoutSeconds: 9000,
    });
    const output = (id: string) =>
      `ok\n[raw output: artifact://${id}]\n\nWall time: 1.50 seconds\nTimeout clamped to 3600s (requested 9000s; allowed range 1-3600s).\n${busy}`;
    expect(print(output("4"), details("4"))).toBe(print(output("8"), details("8")));
  });

  test("the same locator text in the output, or one the metadata does not name, stays data", () => {
    expect(print(`see artifact://3\n\n${notice("3")}`, truncated("3"))).not.toBe(
      print(`see artifact://\n\n${notice("3")}`, truncated("3")),
    );
    expect(print("ok\n[raw output: artifact://4]", minimized("8"))).not.toBe(
      print("ok\n[raw output: artifact://5]", minimized("8")),
    );
    expect(print("see artifact://3\n[raw output: artifact://3] x", truncated("3"))).not.toBe(
      print("see artifact://\n[raw output: artifact://] x", truncated("3")),
    );
    expect(print(`tail\n\n${notice("31")}`, truncated("3"))).not.toBe(print(`tail\n\n${notice("32")}`, truncated("3")));
    expect(print(`head\n[raw output: artifact://3]\nbody\n\n${notice("3")}`, truncated("3"))).not.toBe(
      print(`head\n[raw output: artifact://]\nbody\n\n${notice("3")}`, truncated("3")),
    );
    expect(print(`tail\n\n[user data artifact://3]`, truncated("3"))).not.toBe(
      print(`tail\n\n[user data artifact://]`, truncated("3")),
    );
  });

  // OMP 19.0 spells the same spills `local://N.log` (pi-utils spillUrl) in notices, footers and cut-line selectors.
  describe("19.x local spills", () => {
    const spillNotice = (id: string) => `[Showing lines 41-50 of 50. Read local://${id}.log for full output]`;
    const cut = (id: string) => ({
      meta: { limits: { columnTruncated: { maxColumn: 512, selectorBase: `local://${id}.log` } } },
    });

    test("the spill the metadata names is not evidence; the truncation data is", () => {
      expect(print(`tail\n\n${spillNotice("3")}`, truncated("3"))).toBe(
        print(`tail\n\n${spillNotice("9")}`, truncated("9")),
      );
      expect(print(`tail\n\n${spillNotice("3")}`, truncated("3"))).not.toBe(
        print(`tail\n\n${spillNotice("9")}`, truncated("9", 51)),
      );
      expect(print("ok\n[raw output: local://4.log]", minimized("4"))).toBe(
        print("ok\n[raw output: local://8.log]", minimized("8")),
      );
      const cutNotice = (id: string) =>
        `[Some lines truncated to 512 chars. Use local://${id}.log:raw:1-1 to read line 1 whole]`;
      expect(print(`wide\n\n${cutNotice("3")}`, cut("3"))).toBe(print(`wide\n\n${cutNotice("7")}`, cut("7")));
    });

    test("spill text the metadata does not name stays data, and the two schemes stay distinct", () => {
      expect(print(`see local://3.log\n\n${spillNotice("3")}`, truncated("3"))).not.toBe(
        print(`see local://.log\n\n${spillNotice("3")}`, truncated("3")),
      );
      expect(print("ok\n[raw output: local://4.log]", minimized("8"))).not.toBe(
        print("ok\n[raw output: local://5.log]", minimized("8")),
      );
      expect(print(`tail\n\n${spillNotice("31")}`, truncated("3"))).not.toBe(
        print(`tail\n\n${spillNotice("32")}`, truncated("3")),
      );
      expect(print(`tail\n\n${spillNotice("3")}`, truncated("3"))).not.toBe(
        print(`tail\n\n${notice("3")}`, truncated("3")),
      );
      // A named local:// file is the read's own source, not a spill: distinct files stay distinct evidence.
      const named = (file: string) => ({
        meta: { limits: { columnTruncated: { maxColumn: 512, selectorBase: `local://${file}.log` } } },
      });
      expect(print("wide", named("build"), "read")).not.toBe(print("wide", named("deploy"), "read"));
    });
  });
});
