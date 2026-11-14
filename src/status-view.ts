// The lane board `dori status` prints: open lanes first, the longest without progress on top, closed lanes folded into
// one line each, every line within WIDTH terminal columns.
import { ageText, fitEnd, hhmm, oneLine, padCols, wrap } from "./fit.ts";
import { progressOf } from "./progress.ts";
import { refText } from "./refs.ts";
import type { Lane } from "./store-types.ts";

export const WIDTH = 120;

/** Columns the progress field and the start of the last entry need beside a lane's name; fewer moves them below it. */
const BODY_MIN = 40;

/**
 * `key  status  runtime  ref  progress <age> (<since>)  <last entry>`. The key and the ref are never cut (keys share
 * prefixes, and a cut one names no lane a command can take): their columns are as wide as the widest open lane's, and
 * the rest is cut to the line. When they leave less than BODY_MIN columns, the rest goes on an indented line below.
 */
function laneLine(l: Lane, now: number, cols: { key: number; ref: number }): string[] {
  const since = progressOf(l);
  const id = [
    padCols(l.key, cols.key),
    padCols(l.status, 8),
    padCols(l.sessionRef.runtime, 5),
    padCols(refText(l.sessionRef), cols.ref),
  ].join(" ");
  const last = l.log.at(-1);
  const tail = last ? `${last.kind} ${hhmm(last.at)}: ${oneLine(last.text)}` : "";
  const body = `${padCols(`progress ${ageText(now - since)} (${hhmm(since)})`, 23)} ${tail}`.trimEnd();
  if (WIDTH - Bun.stringWidth(id) - 1 >= BODY_MIN) return [fitEnd(`${id} ${body}`, WIDTH)];
  return [...wrap(id.trimEnd(), WIDTH), `  ${fitEnd(body, WIDTH - 2)}`];
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
  const widest = (cols: (l: Lane) => string) => Math.max(0, ...open.map((l) => Bun.stringWidth(cols(l))));
  const cols = { key: widest((l) => l.key), ref: widest((l) => refText(l.sessionRef)) };
  const lines = open.flatMap((l) => laneLine(l, now, cols));
  for (const status of ["lost", "done"]) {
    const closed = lanes.filter((l) => l.status === status);
    if (closed.length) lines.push(closedLine(status, closed, now));
  }
  return lines;
}
