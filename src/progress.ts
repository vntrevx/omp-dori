// The progress clock: only new evidence (a file changed since the last progress, a link not reported before), a start
// or a READY moves it. A report without new evidence is delivered and logged, but the clock keeps running, so a lane
// that keeps saying "still waiting" is escalated to the lead like a silent one.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { ageText, fitStart, hhmm, oneLine } from "./fit.ts";
import type { Lane } from "./store-types.ts";

/** Minutes without progress before the duty loop tells the lead, once per stall. */
export const ESCALATE_MINUTES = 40;

const LINK_RE = /^(https?:\/\/\S+|[\w.-]+\/[\w.-]+#\d+)$/;

/** When the lane last made progress; a record from before the clock existed counts its last start, report or READY. */
export const progressOf = (lane: Lane): number =>
  lane.progressAt ??
  Math.max(
    lane.createdAt,
    ...lane.log.filter((e) => e.kind === "start" || e.kind === "report" || e.kind === "ready").map((e) => e.at),
  );

/** Why one --evidence value does not count as progress, or its file's modification time (0 for a link) when it does. */
function counted(lane: Lane, ref: string, since: number): { why: string } | { mtime: number } {
  if (LINK_RE.test(ref)) return lane.evidenceSeen?.includes(ref) ? { why: "reported before" } : { mtime: 0 };
  let mtime: number;
  try {
    mtime = statSync(resolve(ref)).mtimeMs;
  } catch {
    return { why: "no such file" };
  }
  if (mtime <= since) return { why: `not changed since ${hhmm(since)}` };
  // A file dated in the future stays newer than the last progress until the clock catches up, so it counts only when
  // its modification time differs from the one it counted with last time.
  return lane.evidenceMtimes?.[resolve(ref)] === mtime ? { why: "counted before, not changed since" } : { mtime };
}

/**
 * Applies a report's evidence to the lane record (the caller saves it). New evidence moves the clock to `now` and clears
 * the nudge count; anything else leaves both alone. Returns the lines the CLI prints, the first one starting PROGRESS.
 */
export function applyEvidence(lane: Lane, evidence: readonly string[], now: number): string[] {
  const since = progressOf(lane);
  lane.progressAt = since;
  const skipped: string[] = [];
  let moved: string | undefined;
  for (const ref of evidence) {
    const c = counted(lane, ref, since);
    if ("why" in c) {
      skipped.push(`  not counted: ${fitStart(oneLine(ref), 60)} (${c.why})`);
      continue;
    }
    moved = ref;
    if (LINK_RE.test(ref)) lane.evidenceSeen = [...(lane.evidenceSeen ?? []), ref];
    else lane.evidenceMtimes = { ...lane.evidenceMtimes, [resolve(ref)]: c.mtime };
  }
  if (moved === undefined)
    return [
      `PROGRESS unchanged since ${hhmm(since)} (${ageText(now - since)}): no new evidence, so the nudge and escalation clock keeps running`,
      ...skipped,
    ];
  lane.progressAt = now;
  lane.nudges = 0;
  lane.lastEvidence = { ref: moved, at: now };
  return [`PROGRESS ${hhmm(now)}: ${fitStart(oneLine(moved), 80)}`, ...skipped];
}

/**
 * When the lead was last told this lane made no progress. A record from before `escalatedAt` was told at its third nudge:
 * the duty loop before the progress clock escalated there (this one nudges twice), so it is not told a second time.
 */
const escalatedOf = (lane: Lane): number | undefined =>
  lane.escalatedAt ?? (lane.nudges >= 3 ? lane.log.findLast((e) => e.kind === "nudge")?.at : undefined);

/**
 * True when the lane has gone ESCALATE_MINUTES without progress and the lead has not been told about this stall. An
 * escalation is always at least ESCALATE_MINUTES after the progress it is about, so one at or before `progressOf` was
 * about an earlier stall (progress made in the same instant as the escalation starts a new one).
 */
export const stalled = (lane: Lane, now: number): boolean => {
  const told = escalatedOf(lane);
  return now - progressOf(lane) >= ESCALATE_MINUTES * 60_000 && (told === undefined || told <= progressOf(lane));
};

/**
 * The [ESCALATE] message: how long, what the pane is doing, how often it was nudged or talked, the last evidence. The
 * key line is the only one that can be long (a lane key is up to 41 characters); the counts get a line of their own so
 * no cut can drop them.
 */
export function escalation(lane: Lane, pane: string, now: number): string {
  const since = progressOf(lane);
  const talk = lane.log.filter((e) => e.kind === "report" && e.at > since).length;
  const head = `[ESCALATE ${lane.key}] no new evidence for ${ageText(now - since)} (since ${hhmm(since)})`;
  const counts = `pane ${pane}, ${lane.nudges} nudges, ${talk} reports without evidence`;
  const last = lane.lastEvidence
    ? `${fitStart(oneLine(lane.lastEvidence.ref), 48)} @ ${hhmm(lane.lastEvidence.at)}`
    : "none recorded";
  return `${head}\n${counts}\nlast evidence: ${last}. Next: check the lane, re-brief it, or close it.`;
}
