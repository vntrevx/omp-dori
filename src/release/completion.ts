import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../../skills/dori-mode/scripts/src/config.ts";
import { type ConsumerPaths, pointer, readJson, regularFile, saveJson, syncDirectory } from "./files.ts";
import { type InstalledState, loadInstalled, releaseId, releasePath } from "./state.ts";

const refreshFile = (paths: ConsumerPaths) => join(paths.root, "consumer-reference-refresh.json");

export function markReferenceRefresh(paths: ConsumerPaths, state: InstalledState): void {
  saveJson(refreshFile(paths), releaseId(state.current));
}

export function clearReferenceRefresh(paths: ConsumerPaths): void {
  if (!regularFile(refreshFile(paths))) return;
  unlinkSync(refreshFile(paths));
  syncDirectory(paths.root);
}

/** The intent survives a killed updater, including a stop before the renderer writes its own journal. */
export function referenceRefresh(paths: ConsumerPaths, state: InstalledState | undefined) {
  if (!regularFile(refreshFile(paths))) return null;
  const target = readJson(refreshFile(paths));
  if (typeof target !== "string" || !/^[a-f0-9]{40}-[a-f0-9]{16}$/.test(target))
    throw new Error("Invalid consumer reference refresh identity");
  if (!state || target !== releaseId(state.current)) return null;
  return {
    pending: true,
    repair: [
      process.execPath,
      join(import.meta.dir, "cli.ts"),
      "install",
      "--version",
      state.current.tag,
      "--home",
      paths.dori,
    ],
  };
}

export type ReleaseAttempt = {
  readonly paths: ConsumerPaths;
  readonly before: InstalledState | undefined;
  readonly source: string | undefined;
  readonly command: string;
};

/** Classify the installed result, not the last fallible maintenance operation. Never recover or mutate here. */
export function releaseFailure(error: unknown, attempt?: ReleaseAttempt): number {
  const reason =
    error instanceof SyntaxError || error instanceof ConfigError
      ? "Invalid configuration or release metadata; inspect the selected files"
      : error instanceof Error
        ? error.message
        : String(error);
  if (attempt) {
    const { paths, before, source, command } = attempt;
    try {
      const current = loadInstalled(paths);
      const selected = pointer(paths.live);
      if (selected !== (current ? releasePath(paths, current.current) : undefined))
        throw new Error("Source pointer and installed receipt disagree");
      if (current && (selected !== source || releaseId(current.current) !== (before && releaseId(before.current)))) {
        const references = referenceRefresh(paths, current);
        console.log(
          JSON.stringify({
            installed: current.current.tag,
            commit: current.current.commit,
            sourceHash: current.current.source.hash,
            previous: current.previous?.tag ?? null,
            status: "committed-maintenance-pending",
            references,
          }),
        );
        console.error(
          `OMP-Dori ${command} committed; ${references ? "reference refresh" : "maintenance"} pending: ${reason}`,
        );
        if (references)
          console.error(
            `Repair with the newer controller: ${references.repair.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}`,
          );
        return 3;
      }
    } catch (inspection) {
      console.error(
        `OMP-Dori release outcome unresolved: ${reason}; ${inspection instanceof Error ? inspection.message : String(inspection)}; run status with this controller`,
      );
      return 4;
    }
  }
  console.error(`OMP-Dori release held: ${reason}`);
  return 2;
}
