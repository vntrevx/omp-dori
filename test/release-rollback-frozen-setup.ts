import { expect } from "bun:test";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extractArchive, readArchive } from "../src/release/archive.ts";
import type { VerifiedBundle } from "../src/release/bundle.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { archive, type ConsumerFixture, withArchive } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// Exact CLI, installer, automatic.ts, state.ts, manifest.ts, references.ts and consumer/omp bytes from
// e6b60c9f5efd45925645672e1841a8a9e20e5592. Text fixtures keep the exact bytes reviewable and independent of Git
// history or a sibling baseline checkout. Only these admission modules are historical; their other dependencies are
// the real current source, not stubs.
const frozenAdmission = [
  ["src/release/cli.ts", "00ab7f999d69b31bbe6c227d7e404bdf013c61f07f95d17caf2fadaed8b2b260"],
  ["src/release/install.ts", "168a5e4bd1e5dc3d41b2b5e3143f6549fc691543bdfbd52db4fb04120debb802"],
  ["src/release/automatic.ts", "999701297a006279797b0e1006b6219b7c423a43d878effbd315a6a2b101341d"],
  ["src/release/state.ts", "65ea13b440235dd3ec22650dd59cd542613e652cef882f5866b692a8281b7f7a"],
  ["src/release/manifest.ts", "37b62455d91ed5cc27c887e6cbcac00d7a2d89dcb8a74c0c33bace3f4f432d30"],
  ["src/release/references.ts", "40bdfacd32d3da27fc8fdbe13ba1983d2dc7e1be842f62b977594643b5f3f9ad"],
  ["scripts/consumer/omp", "7efa973ec21fc9e79841c2685f491155f3d9b0b40999bf4d2ed84c39ca0fb916"],
] as const;

export function repack(bundle: VerifiedBundle, source: string, omp = bundle.manifest.requirements.omp): VerifiedBundle {
  const publicSource = sourceManifest(source);
  const bytes = archive(
    publicSource.files.map((file) => ({
      name: `${bundle.manifest.archive.root}/${file.path}`,
      bytes: readFileSync(join(source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive(
    validateReleaseManifest({
      ...bundle.manifest,
      source: publicSource,
      requirements: { ...bundle.manifest.requirements, omp },
    }),
    bytes,
  );
  return { manifest, files: readArchive(bytes, manifest) };
}

/** A source-bound release; `launcher` replaces its consumer OMP script to make the dispatched release observable. */
export function nativeRelease(
  f: ConsumerFixture,
  selected: string,
  version: string,
  launcher?: string,
): VerifiedBundle {
  const seed = join(f.root, `native-source-${selected}`);
  const native = overlayFixture(seed, join(f.root, `native-${selected}-${version}`), true, selected, version);
  nativeCacheFixture(seed, f.paths.home, native.checkout);
  const release = boundRelease(f, selected, seed);
  if (launcher !== undefined) writeFileSync(join(release.source, "scripts/consumer/omp"), launcher, { mode: 0o755 });
  return repack(release.bundle, release.source, version);
}

/** An authenticated pre-19 release whose launch admission, receipt validation and renderer are the frozen bytes. */
export function frozenRelease(f: ConsumerFixture, oldVersion: string): VerifiedBundle {
  const prior =
    oldVersion === "18.20.0"
      ? boundRelease(f, "prior")
      : { bundle: f.release("legacy").bundle, source: join(f.root, "legacy") };
  if (oldVersion === "18.18.8") extractArchive(prior.bundle.files, prior.bundle.manifest, prior.source);
  // Construct an authenticated release before installation; never modify its frozen installed source or native cache.
  for (const path of ["src", "skills/dori-mode/scripts/src"])
    cpSync(resolve(import.meta.dir, "..", path), join(prior.source, path), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "../package.json"), join(prior.source, "package.json"));
  for (const [path, expected] of frozenAdmission) {
    const bytes = readFileSync(join(import.meta.dir, "fixtures/native-rollback-controller", `${path}.txt`));
    expect(digest(bytes)).toBe(expected);
    mkdirSync(dirname(join(prior.source, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(prior.source, path), bytes, { mode: 0o600 });
  }
  chmodSync(join(prior.source, "scripts/consumer/omp"), 0o755);
  return repack(prior.bundle, prior.source);
}
