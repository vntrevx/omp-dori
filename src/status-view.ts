// The lane board `dori status` prints: open lanes first, the longest without progress on top, closed lanes folded into
// one line each, every line within WIDTH terminal columns.
import { ageText, fitEnd, hhmm, oneLine, padCols, wrap } from "./fit.ts";
import { progressOf, waitingOn, waitingSinceOf } from "./progress.ts";
import { refText } from "./refs.ts";
import type { Lane } from "./store-types.ts";

export const WIDTH = 120;

/** Columns the progress field and the start of the last entry need beside a lane's name; fewer moves them below it. */
const BODY_MIN = 40;
const WAITING_BODY_MIN = 24 + Bun.stringWidth("waiting: … since 00:00");

/**
 * `<last entry>` for a working lane; a waiting lane's `waiting: <target> since HH:MM | <last entry>`, the target cut
 * first so the time always shows, the last entry given what is left of `cols`.
 */
function tailOf(l: Lane, cols: number): string {
  const last = l.log.at(-1);
  const tail = last ? `${last.kind} ${hhmm(last.at)}: ${oneLine(last.text)}` : "";
  if (l.status !== "waiting") return tail;
  const until = ` since ${hhmm(waitingSinceOf(l))}`;
  const waiting = `waiting: ${fitEnd(waitingOn(l), cols - Bun.stringWidth(`waiting: ${until}`))}${until}`;
  const room = cols - Bun.stringWidth(waiting) - 3;
  return room > 1 && tail ? `${waiting} | ${fitEnd(tail, room)}` : waiting;
}

/**
 * `key  status  runtime  ref  progress <age> (<since>)  <tail>`. The key and the ref are never cut (keys share
 * prefixes, and a cut one names no lane a command can take): their columns are as wide as the widest open lane's, and
 * the rest is cut to the line. When the progress field and waiting timestamp cannot fit, the rest moves below.
 */
function laneLine(l: Lane, now: number, cols: { key: number; ref: number }): string[] {
  const since = progressOf(l);
  const id = [
    padCols(l.key, cols.key),
    padCols(l.status, 8),
    padCols(l.sessionRef.runtime, 5),
    padCols(refText(l.sessionRef), cols.ref),
  ].join(" ");
  const progress = padCols(`progress ${ageText(now - since)} (${hhmm(since)})`, 23);
  const body = (room: number) => fitEnd(`${progress} ${tailOf(l, room - 24)}`.trimEnd(), room);
  const room = WIDTH - Bun.stringWidth(id) - 1;
  if (room >= (l.status === "waiting" ? WAITING_BODY_MIN : BODY_MIN)) return [`${id} ${body(room)}`];
  return [...wrap(id.trimEnd(), WIDTH), `  ${body(WIDTH - 2)}`];
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
