import { expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setAutomaticEnabled } from "../src/release/automatic-state.ts";
import { referenceRefresh } from "../src/release/completion.ts";
import { pointer } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import {
  activateRelease,
  type InstalledState,
  loadInstalled,
  recoverInstalled,
  releasePath,
} from "../src/release/state.ts";
import { snapshot } from "../scripts/consumer-smoke-inspect.ts";
import { fixture } from "./release-consumer-setup.ts";
import { blockStatePublication } from "./release-native-recovery-setup.ts";
import { frozenRelease, nativeRelease } from "./release-rollback-frozen-setup.ts";

// POSIX-only: these fixtures require private mode bits, executable shebangs and /bin/sh Git admission.
const posix = test.skipIf(process.platform === "win32");

// Stops the real activation at its first path access after the named on-disk boundary, as a killed updater would.
const interruptedActivation = `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consumerPaths, pointer } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/files.ts"))};
import { activateRelease, loadInstalled, releasePath } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/state.ts"))};
const { home, before, after, phase } = JSON.parse(readFileSync(0, "utf8"));
const paths = consumerPaths(home);
const omp = join(paths.dori, "bin/omp");
const [nativeBefore, source, target] = [pointer(omp), pointer(paths.live), releasePath(paths, after.current)];
const published = () => loadInstalled(paths)?.current.commit === after.current.commit;
const stop = {
  journal: () => existsSync(paths.journal) && !published(),
  state: () => published() && pointer(paths.live) === source && pointer(omp) === nativeBefore,
  native: () => pointer(omp) !== nativeBefore && pointer(paths.live) === source,
  published: () => pointer(paths.live) === target && published() && existsSync(paths.journal),
}[phase];
activateRelease(new Proxy(paths, { get: (object, key) => (stop() ? process.exit(73) : object[key]) }), before, after);
process.exit(99);
`;

async function crossGeneration(oldVersion: string) {
  const f = fixture();
  const one = await installBundle(f.paths, frozenRelease(f, oldVersion), undefined);
  const two = await installBundle(f.paths, nativeRelease(f, "next", "19.0.0"), one);
  // Rollback drops the displaced OMP 19 receipt; the frozen launcher must not attempt a network update here.
  setAutomaticEnabled(f.paths, false, true);
  const after: InstalledState = { version: 1, current: one.current };
  const oldSource = releasePath(f.paths, one.current);
  // The release path is created at runtime; a static import would test this checkout's newer controller instead.
  const frozen = await import(pathToFileURL(join(oldSource, "src/release/state.ts")).href);
  return { f, before: two, after, oldSource, newSource: releasePath(f.paths, two.current), frozen };
}

posix.each(["18.20.0", "18.18.8"])(
  "an interrupted OMP 19 rollback to %s is reconciled by whichever controller each boundary selects",
  async (oldVersion) => {
    const { f, before, after, oldSource, newSource, frozen } = await crossGeneration(oldVersion);
    const omp = join(f.paths.dori, "bin/omp");
    const nativeOld = oldVersion === "18.20.0" ? join(oldSource, "scripts/consumer/omp") : undefined;
    const automatic = await import(pathToFileURL(join(oldSource, "src/release/automatic.ts")).href);
    for (const phase of ["journal", "state", "native", "published"] as const) {
      if (pointer(f.paths.live) === oldSource) activateRelease(f.paths, after, before);
      const result = Bun.spawnSync(
        // The states travel on stdin: their JSON can exceed the kernel's per-argument limit (E2BIG).
        [process.execPath, "-e", interruptedActivation],
        {
          stdin: Buffer.from(JSON.stringify({ home: f.paths.home, before, after, phase })),
          env: { HOME: f.paths.home, PATH: process.env["PATH"] },
          timeout: 10_000,
        },
      );
      expect(result.exitCode, `${phase}: ${result.stderr.toString()}`).toBe(73);
      const selected = phase === "published" ? oldSource : newSource;
      expect(pointer(f.paths.live)).toBe(selected);
      const journal = readFileSync(f.paths.journal);
      // A pointer selecting the frozen controller never exposes an OMP 19 receipt to it.
      if (pointer(f.paths.live) === oldSource || (nativeOld && pointer(omp) === nativeOld)) {
        expect(journal.toString()).not.toContain(before.current.commit);
        expect(loadInstalled(f.paths)).toEqual(after);
      }
      if (phase === "published") {
        // The documented `dori update status` path of the selected frozen release completes the transition.
        expect(frozen.recoverInstalled(f.paths)).toEqual(after);
        await expect(automatic.automaticLaunch(oldSource, f.paths.home)).resolves.toBe(oldSource);
      } else if (phase === "native" && nativeOld) {
        // A frozen launch through the native command holds without changing anything the current controller needs.
        expect(() => frozen.recoverInstalled(f.paths)).toThrow("Source pointer conflicts");
        expect(readFileSync(f.paths.journal)).toEqual(journal);
        expect(pointer(omp)).toBe(nativeOld);
      }
      // The current controller, still selected by the source pointer, recovers every earlier boundary.
      const forward = phase === "native" || phase === "published";
      expect(recoverInstalled(f.paths)).toEqual(forward ? after : before);
      expect(pointer(f.paths.live)).toBe(forward ? oldSource : newSource);
      expect(pointer(omp)).toBe(forward ? nativeOld : join(newSource, "scripts/consumer/omp"));
      expect(loadInstalled(f.paths)).toEqual(forward ? after : before);
      expect(existsSync(f.paths.journal)).toBe(false);
    }
  },
  60_000,
);

posix("a failed OMP 19 rollback publication restores the full journal before the OMP 19 state", async () => {
  const { f, before, newSource } = await crossGeneration("18.20.0");
  const state = readFileSync(f.paths.state);
  const fault = blockStatePublication(f.paths, f.root, releasePath(f.paths, before.previous!));
  await expect(rollbackRelease(fault.paths, before)).rejects.toThrow("Expected a real file");
  expect(pointer(f.paths.live)).toBe(newSource);
  expect(pointer(join(f.paths.dori, "bin/omp"))).toBe(join(newSource, "scripts/consumer/omp"));
  expect(readFileSync(f.paths.state)).toEqual(state);
  expect(JSON.parse(readFileSync(f.paths.journal, "utf8")).before).toEqual(before);
  expect(recoverInstalled(f.paths)).toEqual(before);
  expect(existsSync(f.paths.journal)).toBe(false);
});

posix(
  "an isolated OMP 19 rollback keeps a dispatcher that launches the selected release at every boundary",
  async () => {
    const f = fixture(true);
    const legacy = frozenRelease(f, "18.20.0");
    const one = await installBundle(f.paths, legacy, undefined);
    const two = await installBundle(
      f.paths,
      nativeRelease(f, "next", "19.0.0", `#!/bin/sh\nprintf 'next %s\\n' "$*"\n`),
      one,
    );
    const bin = join(f.paths.dori, "bin");
    const wrappers = snapshot(bin);
    const receipt = readFileSync(join(f.paths.root, "consumer-references.json"));
    // A late activation hold leaves the same files as an interruption at that boundary.
    const held = {
      ...f.paths,
      get journal(): string {
        throw new Error("injected late activation hold");
      },
    };
    await expect(rollbackRelease(held, two)).rejects.toThrow("injected late activation hold");
    expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, two.current));
    expect(snapshot(bin)).toBe(wrappers);
    expect(readFileSync(join(f.paths.root, "consumer-references.json"))).toEqual(receipt);
    expect(referenceRefresh(f.paths, two)).toBeNull();
    const current = Bun.spawnSync([join(bin, "omp"), "--version"], {
      env: { HOME: f.paths.home, PATH: process.env["PATH"] },
      timeout: 10_000,
    });
    expect(current.exitCode, current.stderr.toString()).toBe(0);
    expect(current.stdout.toString()).toStartWith("next --no-extensions");
    // Interrupted after activation, before the frozen renderer replaces the newer dispatcher.
    const interrupted = {
      ...f.paths,
      get home(): string {
        if (pointer(f.paths.live) === releasePath(f.paths, one.current) && !existsSync(f.paths.journal))
          throw new Error("injected interruption before rendering");
        return f.paths.home;
      },
    };
    await expect(rollbackRelease(interrupted, two)).rejects.toThrow("injected interruption before rendering");
    const rolled = loadInstalled(f.paths)!;
    expect(rolled.current).toEqual(one.current);
    expect(snapshot(bin)).toBe(wrappers);
    expect(referenceRefresh(f.paths, rolled)?.pending).toBe(true);
    // CLI repair with both actual controllers is covered by release-rollback-completion.test.ts.
    const older = Bun.spawnSync([join(bin, "omp"), "--version"], {
      env: { HOME: f.paths.home, PATH: process.env["PATH"] },
      timeout: 10_000,
    });
    expect(older.exitCode, older.stderr.toString()).toBe(0);
    expect(older.stdout.toString()).toBe("18.20.0\n");
  },
);
