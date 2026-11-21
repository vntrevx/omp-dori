import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { freezeSource } from "../update/source.ts";
import { extractArchive } from "./archive.ts";
import { setAutomaticEnabled } from "./automatic-state.ts";
import type { VerifiedBundle } from "./bundle.ts";
import {
  type ConsumerPaths,
  owned,
  pointer,
  readJson,
  realDirectory,
  regularFile,
  replacePointer,
  saveJson,
} from "./files.ts";
import { assertNoLiveDori } from "./live.ts";
import { assertNoConsumerLaunches, waitLaunchGate } from "./launch-leases.ts";
import { validateReleaseManifest } from "./manifest.ts";
import { provisionNativeSource } from "./native.ts";
import { assertLock, provisionDependency } from "./provision.ts";
import { preflightReferences } from "./references.ts";
import {
  activateRelease,
  assertInstalledPointer,
  type InstalledState,
  manifestPath,
  releaseId,
  releasePath,
  verifyRelease,
} from "./state.ts";

export function preflightInstallation(paths: ConsumerPaths): void {
  pointer(paths.live);
  if (paths.dori === join(paths.home, ".dori")) {
    const native = pointer(join(paths.dori, "bin/omp"));
    if (native && !/^[a-f0-9]{40}-[a-f0-9]{16}\/scripts\/consumer\/omp$/.test(relative(paths.releases, native)))
      throw new Error("Unmanaged native OMP command; preserve it and move it aside before installing");
  }
  for (const [path, target] of paths.links) {
    realDirectory(dirname(path));
    const current = pointer(path);
    if (current !== undefined && current !== target)
      throw new Error(`Unmanaged installation link: ${path}; preserve it and move it aside before installing`);
  }
  regularFile(paths.config);
  preflightReferences(paths);
  assertNoLiveDori(paths);
}

function freezeDirectories(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isDirectory()) freezeDirectories(path);
  }
  chmodSync(root, 0o555);
}

async function installReferences(
  paths: ConsumerPaths,
  source: string,
  dependency: string,
  manifest: InstalledState["current"],
  launchOwner?: number,
): Promise<void> {
  // Preflight the entire set before the first link/config creation. Existing custom files stay untouched.
  preflightInstallation(paths);
  const native = manifest.requirements.omp === "18.20.0" ? await provisionNativeSource(source, paths.home) : undefined;
  const gate = await waitLaunchGate(paths);
  try {
    assertNoConsumerLaunches(paths, launchOwner);
    preflightInstallation(paths);
    if (!regularFile(paths.config)) {
      const example = JSON.parse(readFileSync(join(source, "skills/dori-mode/references/config.example.json"), "utf8"));
      example.ompUlwPath = dependency;
      example.runtime = process.platform === "darwin" ? "hc" : "herdr";
      if (paths.dori !== join(paths.home, ".dori")) example.stateDir = join(paths.dori, "state");
      if (native || paths.dori !== join(paths.home, ".dori"))
        example.agentCommand = [
          join(paths.dori, "bin/omp"),
          ...(example.agentCommand?.slice(1) ?? ["--dori-role", "lane", "--model", "{model}", "{prompt}"]),
        ];
      writeFileSync(paths.config, `${JSON.stringify(example, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    if (paths.dori !== join(paths.home, ".dori")) {
      // Wrappers are release behavior too. Using this updater's renderer would retain newer bytes on rollback.
      const renderer = "src/release/references.ts";
      if (!manifest.source.files.some((file) => file.path === renderer))
        throw new Error("Selected release has no authenticated consumer reference renderer");
      if (verifyRelease(paths, manifest) !== source || !regularFile(join(source, renderer)))
        throw new Error("Selected consumer reference renderer is unavailable");
      const target = await import(pathToFileURL(join(source, renderer)).href);
      if (typeof target.installIsolatedReferences !== "function")
        throw new Error("Selected consumer reference renderer has no installer");
      await target.installIsolatedReferences(paths, source);
      preflightReferences(paths);
    }
    for (const [path, target] of paths.links) {
      realDirectory(dirname(path), true);
      owned(dirname(path));
      if (pointer(path) === undefined) replacePointer(path, undefined, target);
    }
  } finally {
    gate();
  }
}

export async function installBundle(
  paths: ConsumerPaths,
  bundle: VerifiedBundle,
  before: InstalledState | undefined,
  beforeActivate?: () => void,
  launchOwner?: number,
): Promise<InstalledState> {
  preflightInstallation(paths);
  assertInstalledPointer(paths, before);
  const manifest = validateReleaseManifest(bundle.manifest);
  const receipts = readdirSync(paths.manifests)
    .filter((name) => name.endsWith(".json"))
    .map((name) => validateReleaseManifest(readJson(join(paths.manifests, name))));
  for (const retained of [before?.current, before?.previous, ...receipts]) {
    if (
      retained?.tag === manifest.tag &&
      JSON.stringify(validateReleaseManifest(retained)) !== JSON.stringify(manifest)
    )
      throw new Error(`Release tag ${manifest.tag} is already bound to a different retained manifest`);
  }
  const destination = releasePath(paths, manifest);
  if (before && releaseId(before.current) === releaseId(manifest)) {
    if (JSON.stringify(before.current) !== JSON.stringify(manifest))
      throw new Error("Installed release identity collision");
    const source = verifyRelease(paths, manifest);
    const dependency = await provisionDependency(paths, manifest, source);
    await installReferences(paths, source, dependency, manifest, launchOwner);
    assertInstalledPointer(paths, before);
    return before;
  }
  const stage = mkdtempSync(join(paths.staging, "release-"));
  try {
    const extracted = join(stage, "extracted");
    extractArchive(bundle.files, manifest, extracted);
    assertLock(extracted, manifest);
    const dependency = await provisionDependency(paths, manifest, extracted);
    if (lstatSync(destination, { throwIfNoEntry: false })) verifyRelease(paths, manifest);
    else {
      const frozen = join(stage, "source");
      freezeSource(extracted, frozen, "upstream");
      const receipt = manifestPath(paths, manifest);
      if (regularFile(receipt)) {
        if (JSON.stringify(JSON.parse(readFileSync(receipt, "utf8"))) !== JSON.stringify(manifest))
          throw new Error("Retained release receipt collision");
      } else saveJson(receipt, manifest);
      renameSync(frozen, destination);
      freezeDirectories(destination);
    }
    const source = verifyRelease(paths, manifest);
    await installReferences(paths, source, dependency, manifest, launchOwner);
    const after: InstalledState = { version: 1, current: manifest, ...(before ? { previous: before.current } : {}) };
    beforeActivate?.();
    activateRelease(paths, before, after, launchOwner);
    return after;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function rollbackRelease(
  paths: ConsumerPaths,
  before: InstalledState | undefined,
  version?: string,
): Promise<InstalledState> {
  if (!before?.previous) throw new Error("No retained previous release is available for rollback");
  if (version && version !== before.previous.tag)
    throw new Error("--version differs from the retained previous release");
  preflightInstallation(paths);
  assertInstalledPointer(paths, before);
  const source = verifyRelease(paths, before.previous);
  const dependency = await provisionDependency(paths, before.previous, source);
  await installReferences(paths, source, dependency, before.previous);
  const after: InstalledState = { version: 1, current: before.previous, previous: before.current };
  // A requested rollback remains selected until the owner explicitly resumes automatic updates.
  setAutomaticEnabled(paths, false, true);
  activateRelease(paths, before, after);
  return after;
}
