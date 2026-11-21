import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readAutomaticState } from "../src/release/automatic-state.ts";
import { installBundle } from "../src/release/install.ts";
import { loadInstalled } from "../src/release/state.ts";
import { fixture, posix } from "./release-consumer-setup.ts";
import { digest } from "../src/update/source.ts";

posix.each(["manual", "automatic", "unresolved"])(
  "%s install reports committed state after journal cleanup fails",
  async (mode) => {
    const f = fixture(true);
    const before = await installBundle(f.paths, f.release("one").bundle, undefined);
    const candidate = f.release("two");
    const manifest = { ...candidate.bundle.manifest, prerelease: false };
    const metadata = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(candidate.dist, "release-manifest.json"), metadata);
    writeFileSync(
      join(candidate.dist, "SHA256SUMS"),
      `${digest(candidate.bytes)}  ${manifest.archive.name}\n${digest(metadata)}  release-manifest.json\n`,
    );
    const tools = join(f.root, "runtime-tools");
    mkdirSync(tools, { mode: 0o700 });
    for (const runtime of ["herdr", "hc"]) writeFileSync(join(tools, runtime), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { runConsumerUpdate } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/cli.ts"))};
import { automaticUpdate } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/automatic.ts"))};
import { acquireBundle } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/bundle.ts"))};
import { consumerPaths } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/files.ts"))};
const unlink = fs.unlinkSync;
let failed = false;
spyOn(fs, "unlinkSync").mockImplementation((path) => {
  if (!failed && path === ${JSON.stringify(f.paths.journal)}) {
    failed = true;
    if (${JSON.stringify(mode)} === "unresolved") {
      unlink(${JSON.stringify(f.paths.live)});
      fs.symlinkSync(${JSON.stringify(join(f.paths.releases, `${before.current.commit}-${before.current.source.hash.slice(0, 16)}`))}, ${JSON.stringify(f.paths.live)});
    }
    throw new Error("injected cleanup holds after commit");
  }
  unlink(path);
});
if (${JSON.stringify(mode)} !== "automatic")
  process.exit(await runConsumerUpdate(["install", "--from", ${JSON.stringify(candidate.dist)}, "--home", ${JSON.stringify(f.paths.dori)}]));
console.log(await automaticUpdate(consumerPaths(${JSON.stringify(f.paths.home)}, ${JSON.stringify(f.paths.dori)}), {
  acquire: () => acquireBundle({ from: ${JSON.stringify(candidate.dist)} }),
}));
`,
      ],
      { env: { HOME: f.paths.home, PATH: `${tools}:${process.env["PATH"]}` }, timeout: 20_000 },
    );
    expect(loadInstalled(f.paths)?.current.tag).toBe(manifest.tag);
    expect(loadInstalled(f.paths)?.previous).toEqual(before.current);
    if (mode === "manual") {
      expect(result.exitCode, result.stderr.toString()).toBe(3);
      expect(result.stderr.toString()).toContain("install committed; maintenance pending");
      expect(result.stderr.toString()).not.toContain("release held");
    } else if (mode === "automatic") {
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readAutomaticState(f.paths)).toMatchObject({
        outcome: "installed",
        available: manifest.tag,
        detail: "Committed; maintenance pending: injected cleanup holds after commit",
      });
    } else {
      expect(result.exitCode, result.stderr.toString()).toBe(4);
      expect(result.stderr.toString()).toContain("release outcome unresolved");
      expect(result.stderr.toString()).not.toContain("release held");
    }
  },
);
