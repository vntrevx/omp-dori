import { afterEach, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNativeSource } from "../src/release/native.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { posix } from "./install-setup.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Managed deployments and prior releases keep 18.20.0-bound receipts after the default moved to 19.0.1.
posix("a prior 18.20.0-bound receipt is still admitted by its exact identity; an unknown version is not", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-source-bundle-")));
  roots.push(root);
  const prior = overlayFixture(join(root, "bundle"), join(root, "upstream"), true, "reviewed-overlay", "18.20.0");
  const home = join(root, "home");
  const receipt = nativeCacheFixture(prior.source, home, prior.checkout);
  expect(readSourceBundle(prior.source, true).lock.nativeVersion).toBe("18.20.0");
  expect(assertNativeSource(prior.source, home)).toEqual(receipt);
  writeFileSync(
    join(prior.source, "native-omp.lock"),
    `${JSON.stringify({ ...prior.lock, nativeVersion: "18.99.0" })}\n`,
  );
  expect(() => readSourceBundle(prior.source, true)).toThrow("Invalid source bundle lock");
});
