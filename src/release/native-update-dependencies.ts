import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command } from "../update/deployment-process.ts";
import { bundleEnv } from "./source-bundle.ts";

export const NATIVE_PINS = [
  ["native-addon", "dependencies", "@oh-my-pi/pi-natives"],
  ["extension", "peerDependencies", "@oh-my-pi/pi-coding-agent"],
  ["test/fixtures/omp-native-host", "dependencies", "@oh-my-pi/pi-coding-agent"],
] as const;
export const NATIVE_UPDATE_FILES = [
  "native-omp.lock",
  "native-omp.patch",
  ...NATIVE_PINS.flatMap(([directory]) => [`${directory}/package.json`, `${directory}/bun.lock`]),
] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function pinnedManifest(text: string, section: string, name: string, previous: string, next: string): string {
  const manifest: unknown = JSON.parse(text);
  if (!object(manifest) || !object(manifest[section]) || manifest[section][name] !== previous)
    throw new Error("Native dependency pin differs from the bound source version");
  manifest[section][name] = next;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Bun's generated text lock is JSON with trailing commas. Preserve quoted bytes while removing only trailing commas.
function lockValue(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    text.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (match, closing: string | undefined) => closing ?? match),
  );
  if (
    !object(value) ||
    Object.keys(value).sort().join() !== "configVersion,lockfileVersion,packages,workspaces" ||
    value["lockfileVersion"] !== 2 ||
    value["configVersion"] !== 1 ||
    !object(value["workspaces"]) ||
    Object.keys(value["workspaces"]).join() !== "" ||
    !object(value["workspaces"][""]) ||
    !object(value["packages"])
  )
    throw new Error("Invalid native dependency lock");
  return value;
}

/** Private npm resolution only: no lifecycle scripts, upstream build, caller config, or publisher token. */
export async function prepareNativeDependencies(
  source: string,
  output: string,
  previous: string,
  next: string,
  home: string,
): Promise<void> {
  for (const [directory, section, name] of NATIVE_PINS) {
    const target = join(output, directory);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(target, "package.json"),
      pinnedManifest(readFileSync(join(source, directory, "package.json"), "utf8"), section, name, previous, next),
      { mode: 0o600 },
    );
    writeFileSync(join(target, "bun.lock"), readFileSync(join(source, directory, "bun.lock")), { mode: 0o600 });
    await command(
      [process.execPath, "install", "--ignore-scripts", "--lockfile-only", "--registry=https://registry.npmjs.org"],
      target,
      bundleEnv(home),
      300_000,
    );
  }
}

/** The trusted publisher accepts only the exact pin change, never candidate-supplied scripts or config. */
export function validateNativeDependencies(source: string, output: string, previous: string, next: string): void {
  for (const [directory, section, name] of NATIVE_PINS) {
    const manifest = readFileSync(join(output, directory, "package.json"), "utf8");
    const expected = pinnedManifest(
      readFileSync(join(source, directory, "package.json"), "utf8"),
      section,
      name,
      previous,
      next,
    );
    if (manifest !== expected) throw new Error("Native candidate changed more than the required package pin");
    const lock = lockValue(readFileSync(join(output, directory, "bun.lock"), "utf8"));
    const workspaces = lock["workspaces"] as Record<string, Record<string, unknown>>;
    const root = workspaces[""]!;
    const packageJson = JSON.parse(manifest) as Record<string, unknown>;
    const expectedRoot = Object.fromEntries(
      ["name", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
        .filter((key) => packageJson[key] !== undefined)
        .map((key) => [key, packageJson[key]]),
    );
    // Key order in Bun locks is not the package manifest's order.
    if (
      Object.keys(root).sort().join() !== Object.keys(expectedRoot).sort().join() ||
      Object.keys(expectedRoot).some((key) => JSON.stringify(root[key]) !== JSON.stringify(expectedRoot[key]))
    )
      throw new Error("Native frozen lock workspace differs from its package manifest");
    const packages = lock["packages"] as Record<string, unknown>;
    const selected = packages[name];
    if (!Array.isArray(selected) || selected[0] !== `${name}@${next}`)
      throw new Error("Native frozen lock does not resolve the exact selected package");
    for (const entry of Object.values(packages)) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 4 ||
        typeof entry[0] !== "string" ||
        !/^(?:@[^/@\s]+\/)?[^/@\s]+@\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(entry[0]) ||
        entry[1] !== "" ||
        !object(entry[2]) ||
        typeof entry[3] !== "string" ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry[3])
      )
        throw new Error("Native frozen lock contains an unexpected package source");
    }
  }
}
