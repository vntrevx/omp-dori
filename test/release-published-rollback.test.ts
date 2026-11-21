import { expect } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { committedSource } from "../scripts/release-source.ts";
import { readArchive } from "../src/release/archive.ts";
import { readAutomaticState } from "../src/release/automatic-state.ts";
import { pointer, saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { manifestPath, releasePath, verifyRelease } from "../src/release/state.ts";
import { archive, fixture, posix, withArchive } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";
import { releaseFixture } from "./release-producer-setup.ts";
import { fixtureGit } from "./source-bundle-setup.ts";

// Published v0.1.2, not the later PR54 baseline used by the consumer smoke.
const published = "f5d34ab98ad040a500689fbeefe507e54281eff3";

posix("cross-generation rollback remains readable by v0.1.2 and its Linux update status CLI", async () => {
  const f = fixture();
  const root = resolve(import.meta.dir, "..");
  const source = join(f.root, "published");
  const files = await committedSource(root, published, source);
  const pin = readFileSync(join(source, "omp-ulw.lock"), "utf8").trim();
  const dependency = join(f.paths.dependencies, `omp-ulw-${pin}`);
  const compatibility = process.env["DORI_TEST_COMPAT_ULW_ENTRY"];
  expect(compatibility).toBeDefined();
  fixtureGit(f.root, "clone", "--quiet", "--shared", dirname(compatibility!), dependency);
  expect(fixtureGit(dependency, "rev-parse", "HEAD")).toBe(pin);
  saveJson(`${dependency}.json`, { version: 1, repository: "https://github.com/dbc-hbin/omp-ulw.git", commit: pin });
  const bytes = archive(
    files.files.map((file) => ({
      name: `omp-dori-0.1.2/${file.path}`,
      bytes: readFileSync(join(source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive(
    {
      ...releaseFixture(),
      releaseVersion: "0.1.2",
      tag: "v0.1.2",
      archive: { ...releaseFixture().archive, name: "omp-dori-v0.1.2.tar.gz", root: "omp-dori-0.1.2" },
      commit: published,
      tree: fixtureGit(root, "rev-parse", `${published}^{tree}`),
      source: files,
      ompUlw: { repository: "https://github.com/dbc-hbin/omp-ulw.git", commit: pin },
    },
    bytes,
  );
  expect(manifest.tag).toBe("v0.1.2");
  const one = await installBundle(f.paths, { manifest, files: readArchive(bytes, manifest) }, undefined);
  const two = await installBundle(f.paths, boundRelease(f, "new-generation").bundle, one);
  const config = readFileSync(f.paths.config);
  const rolled = await rollbackRelease(f.paths, two);
  const restored = releasePath(f.paths, one.current);
  expect(pointer(f.paths.live)).toBe(restored);
  const cli = join(f.paths.dori, "bin/dori");
  expect(realpathSync(cli)).toBe(join(restored, "skills/dori-mode/scripts/src/cli.ts"));
  const env = { HOME: f.paths.home, PATH: process.env["PATH"], DORI_TELEMETRY: "0", DO_NOT_TRACK: "1" };
  // Run the unchanged historical reader on every POSIX host, independently of its Linux-only CLI lock.
  const readState = `
    const { consumerPaths } = await import(process.argv[1]);
    const { recoverInstalled, verifyRelease } = await import(process.argv[2]);
    const paths = consumerPaths();
    const state = recoverInstalled(paths);
    verifyRelease(paths, state.current);
    console.log(JSON.stringify(state));
  `;
  const readback = Bun.spawnSync(
    [process.execPath, "-e", readState, join(restored, "src/release/files.ts"), join(restored, "src/release/state.ts")],
    { env, timeout: 10_000 },
  );
  expect({ code: readback.exitCode, stderr: readback.stderr.toString() }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(readback.stdout.toString())).toEqual({ version: 1, current: one.current });
  const status = Bun.spawnSync([process.execPath, cli, "update", "status"], { env, timeout: 10_000 });
  if (process.platform === "linux") {
    expect({ code: status.exitCode, stderr: status.stderr.toString() }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(status.stdout.toString())).toEqual({
      installed: { tag: "v0.1.2", commit: published, sourceHash: files.hash, prerelease: manifest.prerelease },
      previous: null,
    });
  } else {
    // v0.1.2 predates Darwin support and requires /proc for its consumer-lock process identity.
    expect(status.exitCode).toBe(2);
    expect(status.stderr.toString()).toBe("OMP-Dori release held: Consumer process identity is unavailable\n");
    expect(status.stdout.toString()).toBe("");
  }
  expect(rolled.previous).toBeUndefined();
  expect(JSON.parse(readFileSync(f.paths.state, "utf8"))).toEqual({ version: 1, current: one.current });
  expect(verifyRelease(f.paths, two.current)).toBe(releasePath(f.paths, two.current));
  expect(JSON.parse(readFileSync(manifestPath(f.paths, two.current), "utf8"))).toEqual(two.current);
  expect(readAutomaticState(f.paths)).toMatchObject({ enabled: false, outcome: "rollback" });
  expect(readFileSync(f.paths.config)).toEqual(config);
});
