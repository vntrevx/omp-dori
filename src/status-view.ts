// The lane board `dori status` prints: open lanes first, the longest without progress on top, closed lanes folded into
// one line each, every line within WIDTH terminal columns.
import { ageText, fitEnd, hhmm, padCols } from "./fit.ts";
import { progressOf } from "./progress.ts";
import { refText } from "./refs.ts";
import type { Lane } from "./store-types.ts";

const WIDTH = 120;

/** `key  status  runtime  ref  progress <age> (<since>)  <last entry>`, cut to WIDTH columns. */
function laneLine(l: Lane, now: number): string {
  const since = progressOf(l);
  const head = [
    padCols(l.key, 24),
    padCols(l.status, 8),
    padCols(l.sessionRef.runtime, 5),
    padCols(refText(l.sessionRef), 14),
    padCols(`progress ${ageText(now - since)} (${hhmm(since)})`, 23),
  ].join(" ");
  const last = l.log.at(-1);
  const tail = last ? `${last.kind} ${hhmm(last.at)}: ${last.text.replace(/\s+/g, " ").trim()}` : "";
  return fitEnd(`${head} ${tail}`.trimEnd(), WIDTH);
}

/** One summary line per closed status: how many, and the one closed last. */
function closedLine(status: string, lanes: readonly Lane[], now: number): string {
  const latest = lanes.reduce((a, b) => ((b.log.at(-1)?.at ?? 0) > (a.log.at(-1)?.at ?? 0) ? b : a));
  const at = latest.log.at(-1)?.at ?? latest.lastActivityAt;
  return fitEnd(`${status} ${lanes.length} (latest ${latest.key}, ${ageText(now - at)} ago)`, WIDTH);
}

export function laneBoard(lanes: readonly Lane[], now: number): string[] {
  const open = lanes
    .filter((l) => l.status === "working" || l.status === "waiting" || l.status === "ready")
    .sort((a, b) => progressOf(a) - progressOf(b));
  const lines = open.map((l) => laneLine(l, now));
  for (const status of ["lost", "done"]) {
    const closed = lanes.filter((l) => l.status === status);
    if (closed.length) lines.push(closedLine(status, closed, now));
  }
  return lines;
}
