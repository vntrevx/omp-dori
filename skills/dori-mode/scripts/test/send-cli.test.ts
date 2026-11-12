import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const recorder = join(import.meta.dir, "record-fetch.ts");

test("send telegram refuses a --thread or --edit that is not a message id before it posts anything", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    const log = join(state.dir, "fetch.jsonl");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const send = async (...flags: string[]) => {
      rmSync(log, { force: true });
      const r = await run(
        [
          "env",
          `DORI_CONFIG=${config}`,
          `DORI_STATE_DIR=${state.dir}`,
          "DORI_TELEGRAM_TOKEN=123:not-a-real-token",
          `DORI_TEST_FETCH_LOG=${log}`,
          process.execPath,
          "--preload",
          recorder,
          cli,
          "send",
          "telegram",
          "--to",
          "-1001",
          "--text",
          "hello",
          ...flags,
        ],
        { timeoutMs: 20_000 },
      );
      const requests = existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { url: string; body: Record<string, unknown> })
        : [];
      return { ...r, requests };
    };
    const refused = [
      ["--thread", "telegram:-1001/42"],
      ["--thread", "abc"],
      ["--thread", "4.5"],
      ["--thread", "-3"],
      ["--thread", "0x2A"],
      ["--thread", "1e1"],
      ["--thread", ""],
      ["--thread", " "],
      ["--thread"],
      ["--edit", "last"],
      ["--edit", ""],
      ["--edit"],
    ];
    for (const flags of refused) {
      const flag = flags[0]!;
      const r = await send(...flags);
      expect({ flags, code: r.code, err: r.err, out: r.out, requests: r.requests }).toEqual({
        flags,
        code: 1,
        err: `${flag} must be a Telegram ${flag === "--thread" ? "topic" : "message"} id, a whole number above 0`,
        out: "",
        requests: [],
      });
    }
    const posted = await send("--thread", "42");
    expect([posted.code, posted.out]).toEqual([0, "SENT 99"]);
    expect(posted.requests.map((q) => [q.url.split("/").at(-1), q.body["message_thread_id"]])).toEqual([
      ["sendMessage", 42],
    ]);
    const edited = await send("--edit", "7");
    expect(edited.code).toBe(0);
    expect(edited.requests.map((q) => [q.url.split("/").at(-1), q.body["message_id"]])).toEqual([
      ["editMessageText", 7],
    ]);
    const plain = await send();
    expect(plain.requests.map((q) => [q.url.split("/").at(-1), "message_thread_id" in q.body])).toEqual([
      ["sendMessage", false],
    ]);
  } finally {
    state.done();
  }
}, 120_000);

test("send telegram --html adds parse_mode HTML; --html is refused for other platforms", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    const log = join(state.dir, "fetch.jsonl");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const send = async (...flags: string[]) => {
      rmSync(log, { force: true });
      const r = await run(
        [
          "env",
          `DORI_CONFIG=${config}`,
          `DORI_STATE_DIR=${state.dir}`,
          "DORI_TELEGRAM_TOKEN=tok",
          `DORI_TEST_FETCH_LOG=${log}`,
          process.execPath,
          "--preload",
          recorder,
          cli,
          "send",
          "telegram",
          "--to",
          "-1001",
          "--text",
          "hi",
          ...flags,
        ],
        { timeoutMs: 20_000 },
      );
      const requests = existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { url: string; body: Record<string, unknown> })
        : [];
      return { ...r, requests };
    };
    // --html adds parse_mode: HTML to sendMessage
    const withHtml = await send("--html");
    expect([withHtml.code, withHtml.out]).toEqual([0, "SENT 99"]);
    expect(withHtml.requests.map((q) => [q.url.split("/").at(-1), q.body["parse_mode"]])).toEqual([
      ["sendMessage", "HTML"],
    ]);
    // without --html, parse_mode is absent
    const noHtml = await send();
    expect(noHtml.requests.map((q) => ["parse_mode" in q.body])).toEqual([[false]]);
    // --html adds parse_mode: HTML to editMessageText
    const editHtml = await send("--edit", "5", "--html");
    expect(editHtml.requests.map((q) => [q.url.split("/").at(-1), q.body["parse_mode"]])).toEqual([
      ["editMessageText", "HTML"],
    ]);
    // --html refused for slack and discord (no network calls needed)
    for (const platform of ["slack", "discord"] as const) {
      const r = await run(
        [
          "env",
          `DORI_CONFIG=${config}`,
          `DORI_STATE_DIR=${state.dir}`,
          process.execPath,
          cli,
          "send",
          platform,
          "--to",
          "C1",
          "--text",
          "hi",
          "--html",
        ],
        { timeoutMs: 20_000 },
      );
      expect({ platform, code: r.code, err: r.err }).toEqual({
        platform,
        code: 1,
        err: `--html is only supported for telegram, not ${platform}`,
      });
    }
  } finally {
    state.done();
  }
}, 120_000);
