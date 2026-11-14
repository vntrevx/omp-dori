// The progress clock: only new evidence (a file changed since the last progress, a link not reported before), a start
// or a READY moves it. A report without new evidence is delivered and logged, but the clock keeps running, so a lane
// that keeps saying "still waiting" is escalated to the lead like a silent one.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { ageText, fitEnd, fitStart, hhmm } from "./fit.ts";
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

/** Why one --evidence value does not count as progress, or undefined when it does. */
function notCounted(lane: Lane, ref: string, since: number): string | undefined {
  if (LINK_RE.test(ref)) return lane.evidenceSeen?.includes(ref) ? "reported before" : undefined;
  let mtime: number;
  try {
    mtime = statSync(resolve(ref)).mtimeMs;
  } catch {
    return "no such file";
  }
  return mtime > since ? undefined : `not changed since ${hhmm(since)}`;
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
    const why = notCounted(lane, ref, since);
    if (why !== undefined) {
      skipped.push(`  not counted: ${fitStart(ref, 60)} (${why})`);
      continue;
    }
    moved = ref;
    if (LINK_RE.test(ref)) lane.evidenceSeen = [...(lane.evidenceSeen ?? []), ref];
  }
  if (moved === undefined)
    return [
      `PROGRESS unchanged since ${hhmm(since)} (${ageText(now - since)}): no new evidence, so the nudge and escalation clock keeps running`,
      ...skipped,
    ];
  lane.progressAt = now;
  lane.nudges = 0;
  lane.lastEvidence = { ref: moved, at: now };
  return [`PROGRESS ${hhmm(now)}: ${fitStart(moved, 80)}`, ...skipped];
}

/**
 * True when the lane has gone ESCALATE_MINUTES without progress and the lead has not been told about this stall. An
 * escalation is always at least ESCALATE_MINUTES after the progress it is about, so one at or before `progressOf` was
 * about an earlier stall (progress made in the same instant as the escalation starts a new one).
 */
export const stalled = (lane: Lane, now: number): boolean =>
  now - progressOf(lane) >= ESCALATE_MINUTES * 60_000 &&
  (lane.escalatedAt === undefined || lane.escalatedAt <= progressOf(lane));

/** The [ESCALATE] message: how long, what the pane is doing, how often it was nudged or talked, the last evidence. */
export function escalation(lane: Lane, pane: string, now: number): string {
  const since = progressOf(lane);
  const talk = lane.log.filter((e) => e.kind === "report" && e.at > since).length;
  const head = `[ESCALATE ${lane.key}] no new evidence for ${ageText(now - since)} (since ${hhmm(since)}); pane ${pane}, ${lane.nudges} nudges, ${talk} reports without evidence`;
  const last = lane.lastEvidence
    ? `${fitStart(lane.lastEvidence.ref, 48)} @ ${hhmm(lane.lastEvidence.at)}`
    : "none recorded";
  return `${fitEnd(head, 120)}\nlast evidence: ${last}. Next: check the lane, re-brief it, or close it.`;
}
