import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { laneStartCommand } from "../skills/dori-mode/scripts/src/launch-session.ts";
import { quoteForPane } from "../skills/dori-mode/scripts/src/launch-footer.ts";
import fixture from "./fixtures/omp-native-host/package.json";

// POSIX-only: launch uses the user's shell's process-scoped assignment syntax.
test.skipIf(process.platform === "win32")(
  "native Bash passes the launched run to the real report CLI",
  async () => {
    const root = resolve(import.meta.dir, "..");
    const home = mkdtempSync(join(tmpdir(), "dori-request-native-"));
    const runId = "00000000-0000-4000-8000-0000000000aa";
    try {
      const command = laneStartCommand({ key: "native-request", thread: "none", runId }, [
        process.execPath,
        "--no-env-file",
        join(root, "test/fixtures/omp-native-host/request-run.ts"),
        root,
        home,
      ]);
      const restart = [process.execPath, "-e", "console.log(JSON.stringify({ restartRun: process.env.DORI_LANE_RUN }))"]
        .map(quoteForPane)
        .join(" ");
      const child = Bun.spawn(["sh", "-c", `${command} && ${restart}`], {
        cwd: home,
        env: {
          PATH: process.env["PATH"],
          HOME: home,
          TMPDIR: home,
          NO_COLOR: "1",
          PI_CODING_AGENT_DIR: join(home, "agent"),
          DORI_LANE_RUN: "",
          DORI_TEST_OMP_ROOT: process.env["DORI_TEST_OMP_ROOT"],
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 25_000,
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(
        out
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        {
          runId,
          requestId: "discord:111111111111111111:222222222222222222",
          networkAttempts: 0,
          nativeVersion: fixture.dependencies["@oh-my-pi/pi-coding-agent"],
        },
        { restartRun: "" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  30_000,
);
