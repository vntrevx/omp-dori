import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-pane state written by the omp-dori extension from inside a Dori or lane session and read by the `dori` CLI.
 * omp exposes no session id in argv or the environment and no goal readback on screen that dori can trust, so the
 * session reports itself here. One file per herdr pane or hc terminal; the extension is the only writer.
 */
export type DoriRole = "dori" | "lane";
export type GoalStatus = "none" | "active" | "paused" | "complete" | "dropped" | "blocked";

export interface ModelReadback {
  readonly requested: { readonly provider: string; readonly id: string } | null;
  readonly observed: { readonly provider: string; readonly id: string } | null;
  readonly status: "matched" | "mismatch" | "unavailable" | "unknown" | "unrequested";
  readonly billing: "subscription" | "non-subscription" | "unknown";
  readonly checkedAt: string;
  readonly source: "native-extension" | "launch-preflight";
  readonly reason?: string;
  /** Present when a trailing `:<level>` selected the base model: the requested and live native thinking levels. */
  readonly thinking?: { readonly requested: string; readonly observed: string | null };
}

export type PaneState = {
  readonly paneId: string;
  readonly role: DoriRole;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly discordLaneKey?: string;
  readonly discordLaneInbox?: true;
  readonly discordLaneReceiver?: { readonly channel: string; readonly stateDir: string };
  readonly cwd: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly goal: { readonly status: GoalStatus; readonly objective?: string };
  /** A tool approval prompt is open in this session: never type into the pane. */
  readonly approvalPending: boolean;
  /** Last native agent lifecycle event; absent in older records, independent of goal status. */
  readonly agentStatus?: "idle" | "working";
  /** Native catalog and selected-model agreement, never billing authorization or a quota balance. */
  readonly modelReadback?: ModelReadback;
};

/** The native catalog distinguishes literal colon-tagged ids from thinking suffixes. */
export const exactModelIdentity = (value: string): ModelReadback["requested"] => {
  const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([^\s*,]+)$/.exec(value);
  return match?.[1] && match[2] ? { provider: match[1], id: match[2] } : null;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** OMP's trailing `:<level>` model selector suffix; any other colon suffix stays part of a literal id. */
export const thinkingSuffix = (id: string): { readonly base: string; readonly level: string } | null => {
  const at = id.lastIndexOf(":");
  return at > 0 && THINKING_LEVELS.has(id.slice(at + 1)) ? { base: id.slice(0, at), level: id.slice(at + 1) } : null;
};

export const paneStateDir = (stateDir: string): string => join(stateDir, "sessions");

export const paneStatePath = (stateDir: string, paneId: string): string =>
  join(paneStateDir(stateDir), `${encodeURIComponent(paneId)}.json`);

export const readPaneState = (stateDir: string, paneId: string): PaneState | null => {
  try {
    return JSON.parse(readFileSync(paneStatePath(stateDir, paneId), "utf8")) as PaneState;
  } catch {
    return null;
  }
};

// temp file + rename so a concurrent reader never sees a half-written state
export const writePaneState = (stateDir: string, state: PaneState): void => {
  mkdirSync(paneStateDir(stateDir), { recursive: true });
  const path = paneStatePath(stateDir, state.paneId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
};
