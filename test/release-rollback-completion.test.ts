import { expect } from "bun:test";
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { saveJson } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { loadInstalled, releasePath } from "../src/release/state.ts";
import { digest } from "../src/update/source.ts";
import { archive, fixture, posix } from "./release-consumer-setup.ts";
import { frozenRelease, nativeRelease } from "./release-rollback-frozen-setup.ts";

posix("the CLI reports committed rollback separately from a hold when reference refresh fails", async () => {
  const f = fixture(true);
  const legacy = frozenRelease(f, "18.20.0");
  const one = await installBundle(f.paths, legacy, undefined);
  await installBundle(f.paths, nativeRelease(f, "next", "19.0.0"), one);
  const cli = resolve(import.meta.dir, "../src/release/cli.ts");
  const selected = releasePath(f.paths, one.current);
  const tools = join(f.root, "runtime-tools");
  mkdirSync(tools, { mode: 0o700 });
  // The updater only checks runtime presence; it must never start a runtime in this fixture.
  for (const runtime of ["herdr", "hc"]) writeFileSync(join(tools, runtime), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const env = { HOME: f.paths.home, PATH: `${tools}:${process.env["PATH"]}` };
  const run = (entry: string, args: string[]) =>
    Bun.spawnSync([process.execPath, entry, ...args, "--home", f.paths.dori], { env, timeout: 20_000 });
  const before = loadInstalled(f.paths);
  const held = run(cli, ["rollback", "--version", "v9.9.9"]);
  expect(held.exitCode, held.stderr.toString()).toBe(2);
  expect(held.stderr.toString()).toContain("release held");
  expect(loadInstalled(f.paths)).toEqual(before);
  const references = readFileSync(join(f.paths.root, "consumer-references.json"));
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { runConsumerUpdate } from ${JSON.stringify(cli)};
const rename = fs.renameSync;
spyOn(fs, "renameSync").mockImplementation((from, to) => {
  if (to === ${JSON.stringify(join(f.paths.dori, "bin/dori"))} &&
      fs.realpathSync(${JSON.stringify(f.paths.live)}) === ${JSON.stringify(selected)})
    throw new Error("injected reference publication failure");
  rename(from, to);
});
process.exit(await runConsumerUpdate(["rollback", "--home", ${JSON.stringify(f.paths.dori)}]));
`,
    ],
    { env, timeout: 20_000 },
  );
  expect(loadInstalled(f.paths)?.current).toEqual(one.current);
  expect(readlinkSync(f.paths.live)).toBe(selected);
  expect(readFileSync(join(f.paths.root, "consumer-references.json"))).toEqual(references);
  expect(result.exitCode, result.stderr.toString()).toBe(3);
  expect(result.stderr.toString()).toContain("rollback committed; reference refresh pending");
  expect(result.stderr.toString()).not.toContain("release held");
  expect(JSON.parse(result.stdout.toString()).status).toBe("committed-maintenance-pending");
  // A second process sees the durable intent, not just the first updater's exception.
  const status = run(cli, ["status"]);
  expect(status.exitCode, status.stderr.toString()).toBe(3);
  const reported = JSON.parse(status.stdout.toString());
  expect(reported.installed.tag).toBe(one.current.tag);
  expect(reported.references.repair).toEqual([
    process.execPath,
    cli,
    "install",
    "--version",
    one.current.tag,
    "--home",
    f.paths.dori,
  ]);
  const launch = Bun.spawnSync([join(f.paths.dori, "bin/omp"), "--version"], { env, timeout: 10_000 });
  expect(launch.exitCode, launch.stderr.toString()).toBe(0);
  expect(launch.stdout.toString()).toBe("18.20.0\n");
  const frozenCli = join(selected, "src/release/cli.ts");
  const frozenStatus = run(frozenCli, ["status"]);
  expect(frozenStatus.exitCode, frozenStatus.stderr.toString()).toBe(0);
  expect(JSON.parse(frozenStatus.stdout.toString()).installed.tag).toBe(one.current.tag);
  // Use the same exact release assets for both controllers; no network or direct installer shortcut.
  const dist = join(f.root, "repair-dist");
  mkdirSync(dist, { mode: 0o700 });
  const bytes = archive(
    legacy.files.map((file) => ({
      name: `${legacy.manifest.archive.root}/${file.path}`,
      bytes: Buffer.from(file.bytes),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  expect(digest(bytes)).toBe(legacy.manifest.archive.sha256);
  const metadata = `${JSON.stringify(legacy.manifest, null, 2)}\n`;
  writeFileSync(join(dist, legacy.manifest.archive.name), bytes);
  writeFileSync(join(dist, "release-manifest.json"), metadata);
  writeFileSync(
    join(dist, "SHA256SUMS"),
    `${digest(bytes)}  ${legacy.manifest.archive.name}\n${digest(metadata)}  release-manifest.json\n`,
  );
  const frozenRepair = run(frozenCli, ["install", "--from", dist]);
  expect(frozenRepair.exitCode).toBe(2);
  expect(frozenRepair.stderr.toString()).toContain("Release requirements do not match the supported runtime");
  const repair = Bun.spawnSync([...reported.references.repair, "--from", dist], { env, timeout: 20_000 });
  expect(repair.exitCode, repair.stderr.toString()).toBe(0);
  expect(loadInstalled(f.paths)?.current).toEqual(one.current);
  expect(readlinkSync(f.paths.live)).toBe(selected);
  const repairedStatus = run(cli, ["status"]);
  expect(repairedStatus.exitCode, repairedStatus.stderr.toString()).toBe(0);
  expect(JSON.parse(repairedStatus.stdout.toString()).references).toBeNull();
  expect(readFileSync(join(f.paths.dori, "bin/omp"), "utf8")).toContain('case "$protocol" in\n  18.20.0) omp=');
  const repairedLaunch = Bun.spawnSync([join(f.paths.dori, "bin/omp"), "--version"], { env, timeout: 10_000 });
  expect(repairedLaunch.exitCode, repairedLaunch.stderr.toString()).toBe(0);
  expect(repairedLaunch.stdout.toString()).toBe("18.20.0\n");
});

posix("status reports a committed recovery when its journal cleanup fails", async () => {
  const f = fixture(true);
  const one = await installBundle(f.paths, frozenRelease(f, "18.20.0"), undefined);
  await installBundle(f.paths, nativeRelease(f, "next", "19.0.0"), one);
  // An interrupted cross-generation commit has published the old receipt, but not yet its source pointer.
  const after = { version: 1 as const, current: one.current };
  saveJson(f.paths.state, after);
  saveJson(f.paths.journal, { version: 1, after });
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { runConsumerUpdate } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/cli.ts"))};
const unlink = fs.unlinkSync;
spyOn(fs, "unlinkSync").mockImplementation((path) => {
  if (path === ${JSON.stringify(f.paths.journal)}) throw new Error("injected recovery cleanup failure");
  unlink(path);
});
process.exit(await runConsumerUpdate(["status", "--home", ${JSON.stringify(f.paths.dori)}]));
`,
    ],
    { env: { HOME: f.paths.home, PATH: process.env["PATH"] }, timeout: 20_000 },
  );
  expect(loadInstalled(f.paths)).toEqual(after);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, one.current));
  expect(result.exitCode, result.stderr.toString()).toBe(3);
  expect(result.stderr.toString()).toContain("recovery committed; maintenance pending");
  expect(result.stderr.toString()).not.toContain("release held");
});
