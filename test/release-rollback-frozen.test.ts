import { expect, test } from "bun:test";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { automaticUpdate } from "../src/release/automatic.ts";
import { readAutomaticState } from "../src/release/automatic-state.ts";
import { saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { nativeDirectory } from "../src/release/native.ts";
import { manifestPath, releasePath, verifyRelease } from "../src/release/state.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixture, portableFixture } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";
import { frozenRelease, nativeRelease } from "./release-rollback-frozen-setup.ts";

// POSIX-only: these fixtures require private mode bits, executable shebangs and /bin/sh Git admission.
const posix = test.skipIf(process.platform === "win32");

posix.each([
  ["18.20.0", "19.0.0"],
  ["18.20.0", "19.1.2"],
  ["18.18.8", "19.0.0"],
])("rollback restores OMP %s frozen launch admission after OMP %s", async (oldVersion, newVersion) => {
  const f = fixture();
  const legacy = frozenRelease(f, oldVersion);
  const one = await installBundle(f.paths, legacy, undefined);
  const oldSource = releasePath(f.paths, one.current);
  const oldBytes = sourceManifest(oldSource);
  const oldNative = oldVersion === "18.20.0" ? nativeDirectory(oldSource, f.paths.home) : undefined;
  const oldSnapshot = oldNative
    ? { directory: oldNative, source: sourceManifest(oldNative), launcher: readFileSync(join(oldNative, "bin/omp")) }
    : undefined;
  const two = await installBundle(f.paths, nativeRelease(f, "next", newVersion), one);
  const config = readFileSync(f.paths.config);
  const newSource = verifyRelease(f.paths, two.current);
  const newBytes = sourceManifest(newSource);
  const newReceipt = readFileSync(manifestPath(f.paths, two.current));
  const newNative = nativeDirectory(newSource, f.paths.home);
  const newNativeBytes = sourceManifest(newNative);
  const newLauncher = readFileSync(join(newNative, "bin/omp"));
  // A manual install of the older release would record the OMP 19 receipt its frozen controller rejects.
  const installed = readFileSync(f.paths.state);
  const receipts = readdirSync(f.paths.manifests).sort();
  await expect(installBundle(f.paths, legacy, two)).rejects.toThrow('use "dori update rollback"');
  expect(readFileSync(f.paths.state)).toEqual(installed);
  expect(readdirSync(f.paths.manifests).sort()).toEqual(receipts);
  expect(readlinkSync(f.paths.live)).toBe(newSource);
  expect(readFileSync(f.paths.config)).toEqual(config);
  const rolled = await rollbackRelease(f.paths, two);
  expect(rolled.current).toEqual(one.current);
  expect(rolled.previous).toBeUndefined();
  expect(readAutomaticState(f.paths)).toMatchObject({ enabled: false, outcome: "rollback" });
  expect(readlinkSync(f.paths.live)).toBe(oldSource);
  // The release path is created at runtime; a static import would test this checkout's newer controller instead.
  const frozen = await import(pathToFileURL(join(oldSource, "src/release/automatic.ts")).href);
  await expect(frozen.automaticLaunch(oldSource, f.paths.home)).resolves.toBe(oldSource);
  expect(readAutomaticState(f.paths)).toMatchObject({ enabled: false, outcome: "rollback" });
  // Negative control: the displaced manifest reproduces the actual disabled-update launch failure.
  saveJson(f.paths.state, { ...rolled, previous: two.current });
  try {
    await expect(frozen.automaticLaunch(oldSource, f.paths.home)).rejects.toThrow("supported runtime");
  } finally {
    saveJson(f.paths.state, rolled);
  }
  expect(sourceManifest(oldSource)).toEqual(oldBytes);
  expect(sourceManifest(newSource)).toEqual(newBytes);
  expect(verifyRelease(f.paths, two.current)).toBe(newSource);
  expect(readFileSync(manifestPath(f.paths, two.current))).toEqual(newReceipt);
  if (oldSnapshot) {
    expect(sourceManifest(oldSnapshot.directory)).toEqual(oldSnapshot.source);
    expect(readFileSync(join(oldSnapshot.directory, "bin/omp"))).toEqual(oldSnapshot.launcher);
  }
  expect(sourceManifest(newNative)).toEqual(newNativeBytes);
  expect(readFileSync(join(newNative, "bin/omp"))).toEqual(newLauncher);
  expect(readFileSync(f.paths.config)).toEqual(config);
  // The unsupported previous pointer is consumed, not replaced by a forged manifest or an executable shim.
  await expect(rollbackRelease(f.paths, rolled)).rejects.toThrow("No retained previous release");
});

posix("automatic update never activates a newer pre-19 controller over an OMP 19 receipt", async () => {
  // The candidate must support this host profile so the controller hold, not the profile check, rejects it.
  const f = portableFixture();
  const one = await installBundle(f.paths, nativeRelease(f, "one", "19.0.0"), undefined);
  const selected = JSON.parse(readFileSync(f.paths.config, "utf8"));
  selected.runtime = process.platform === "darwin" ? "hc" : "herdr";
  saveJson(f.paths.config, selected);
  const later = boundRelease(f, "later").bundle;
  expect(later.manifest.requirements.omp).toBe("18.20.0");
  const candidate = { ...later, manifest: { ...later.manifest, prerelease: false } };
  const installed = readFileSync(f.paths.state);
  const receipts = readdirSync(f.paths.manifests).sort();
  const config = readFileSync(f.paths.config);
  const source = releasePath(f.paths, one.current);
  expect(await automaticUpdate(f.paths, { now: 42, acquire: async () => candidate, checkTools: () => {} })).toBe(
    source,
  );
  expect(readAutomaticState(f.paths)).toMatchObject({ outcome: "failed" });
  expect(readAutomaticState(f.paths).detail).toContain('use "dori update rollback"');
  expect(readFileSync(f.paths.state)).toEqual(installed);
  expect(readdirSync(f.paths.manifests).sort()).toEqual(receipts);
  expect(readlinkSync(f.paths.live)).toBe(source);
  expect(readFileSync(f.paths.config)).toEqual(config);
});

posix("same-generation OMP 19 rollback retains its displaced release for redo", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, nativeRelease(f, "one", "19.0.0"), undefined);
  const two = await installBundle(f.paths, nativeRelease(f, "two", "19.1.2"), one);
  const rolled = await rollbackRelease(f.paths, two);
  expect(rolled.current).toEqual(one.current);
  expect(rolled.previous).toEqual(two.current);
  const redone = await rollbackRelease(f.paths, rolled);
  expect(redone.current).toEqual(two.current);
  expect(redone.previous).toEqual(one.current);
  expect(readAutomaticState(f.paths).enabled).toBe(false);
});
