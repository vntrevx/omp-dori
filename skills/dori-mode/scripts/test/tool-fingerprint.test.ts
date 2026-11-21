import { describe, expect, test } from "bun:test";
import { resultFingerprint } from "../src/tool-fingerprint.ts";

// Text layouts of OMP 18.20.0: bash #buildCompletedResult puts the wall time first among its notices
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

  describe("OMP 19 numbered spills", () => {
    const raw = (file: string) => `[raw output: local://${file}.log]`;
    const spillNotice = (file: string) => `[Showing lines 41-50 of 50. Read local://${file}.log for full output]`;
    const cutNotice = (file: string, line = 1) =>
      `[Some lines truncated to 512 chars. Use local://${file}.log:raw:${line}-${line} to read line ${line} whole]`;
    const cut = (selector: { artifactId: string } | { selectorBase: string }) => ({
      meta: { limits: { columnTruncated: { maxColumn: 512, lines: { first: 1, last: 1 }, ...selector } } },
    });
    const selector = (file: string) => cut({ selectorBase: `local://${file}.log` });

    test("a minimized footer is the same evidence across spill numbers, including before Bash notices", () => {
      expect(print(`ok\n${raw("4")}`, minimized("4"))).toBe(print(`ok\n${raw("8")}`, minimized("8")));
      expect(print(`ok\n${raw("4")}\n\nWall time: 1.50 seconds\n${busy}`, { ...minimized("4"), ...timed })).toBe(
        print(`ok\n${raw("8")}\n\n${busy}`, minimized("8")),
      );
    });

    test("a truncation notice ignores the spill number but not truncation data or the locator scheme", () => {
      expect(print(`tail\n\n${spillNotice("3")}`, truncated("3"))).toBe(
        print(`tail\n\n${spillNotice("9")}`, truncated("9")),
      );
      expect(print(`tail\n\n${spillNotice("3")}`, truncated("3"))).not.toBe(
        print(`tail\n\n${spillNotice("9")}`, truncated("9", 51)),
      );
      expect(print(`tail\n\n${spillNotice("3")}`, truncated("3"))).not.toBe(
        print(`tail\n\n${notice("3")}`, truncated("3")),
      );
    });

    test("cut-line selectors ignore the spill number but keep the line selector", () => {
      expect(print(`wide\n\n${cutNotice("3")}`, selector("3"), "read")).toBe(
        print(`wide\n\n${cutNotice("7")}`, selector("7"), "read"),
      );
      expect(print(`wide\n\n${cutNotice("3")}`, cut({ artifactId: "3" }))).toBe(
        print(`wide\n\n${cutNotice("7")}`, cut({ artifactId: "7" })),
      );
      expect(print(`wide\n\n${cutNotice("3")}`, selector("3"), "read")).not.toBe(
        print(`wide\n\n${cutNotice("7", 2)}`, selector("7"), "read"),
      );
    });

    test("literal output and text not backed by matching metadata remain evidence", () => {
      expect(print(`see local://3.log\n\n${spillNotice("3")}`, truncated("3"))).not.toBe(
        print(`see local://9.log\n\n${spillNotice("9")}`, truncated("9")),
      );
      expect(print(`head\n${raw("4")}\nbody\n${raw("4")}`, minimized("4"))).not.toBe(
        print(`head\n${raw("8")}\nbody\n${raw("8")}`, minimized("8")),
      );
      expect(print(`ok\n${raw("4")}`, minimized("8"))).not.toBe(print(`ok\n${raw("5")}`, minimized("8")));
      expect(print(`ok\n${raw("4")}`, {})).not.toBe(print(`ok\n${raw("5")}`, {}));
      expect(print(`tail\n\n${spillNotice("31")}`, truncated("3"))).not.toBe(
        print(`tail\n\n${spillNotice("32")}`, truncated("3")),
      );
      expect(print("tail\n\n[Showing local://3.log in user data]", truncated("3"))).not.toBe(
        print("tail\n\n[Showing local://9.log in user data]", truncated("9")),
      );
    });

    test("named local files remain evidence even where native spills are written", () => {
      expect(print("wide", selector("build"), "read")).not.toBe(print("wide", selector("deploy"), "read"));
      expect(print(`wide\n\n${cutNotice("build")}`, selector("build"), "read")).not.toBe(
        print(`wide\n\n${cutNotice("deploy")}`, selector("deploy"), "read"),
      );
      expect(print(`ok\n${raw("build")}`, minimized("build"))).not.toBe(
        print(`ok\n${raw("deploy")}`, minimized("deploy")),
      );
    });
  });
});
