import type { ReleaseManifest } from "./types.ts";

/**
 * Pre-19 controllers validate every receipt they load, so they reject a displaced OMP 19 manifest.
 * Kept apart from state.ts and manifest.ts, which retained pre-19 releases carry as their own frozen copies.
 */
export function controllerReads(current: ReleaseManifest, previous: ReleaseManifest): boolean {
  return current.requirements.omp.startsWith("19.") || !previous.requirements.omp.startsWith("19.");
}
