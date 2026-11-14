import { DeliveryUncertain, failureDetail } from "./delivery.ts";
import { type Deps, prompt } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { flushInbox, sendOrThrow, tellLead } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { refText } from "./refs.ts";
import { escalation, progressOf, stalled } from "./progress.ts";
import type { Lane } from "./store-types.ts";
import { ageText, hhmm } from "./fit.ts";

/** Quiet minutes before the first and second nudge; the lead is told at ESCALATE_MINUTES without progress. */
export const NUDGE_MINUTES = [10, 20] as const;

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** An open lane the duty loop watches; a lane being migrated is left alone (no nudge, no lost, no activity stamp). */
const watched = (lane: Lane): boolean =>
  (lane.status === "working" || lane.status === "waiting") && lane.migration !== true;

/** One proactive pass: flush inboxes of panes that became idle, nudge silent lanes, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  for (const ref of d.store.inboxPanes()) {
    const paneId = refText(ref);
    try {
      const result = await flushInbox(d, ref);
      // flushInbox follows a `.forward` marker; the counts are read where the entries live now.
      const at = d.store.forwardOf(ref) ?? ref;
      if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
      if (result === "no-agent") {
        events.push({
          pane: paneId,
          action: "inbox-held",
          detail: `no agent in front; ${d.store.queued(at).length} message(s) kept`,
        });
      }
      // Held after an ambiguous delivery (#89): shown on every pass, resent never; the lead was told once.
      const held = d.store.queued(at).filter((m) => m.attempt?.state === "ambiguous").length;
      if (held > 0)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: `${held} message(s) held, not resent` });
    } catch (e) {
      // One pane's failed delivery must never kill the loop for every other pane and lane.
      if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
      else if (e instanceof DeliveryUncertain && !e.typed)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: failureDetail(e) });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const listed of d.store.lanes()) {
    if (!watched(listed)) continue;
    try {
      const { status: st } = await d.runtimes.for(listed.sessionRef).probe(listed.sessionRef);
      // Re-read right before deciding and saving: a report, a READY or a migration may have landed during the probe.
      const lane = d.store.lane(listed.key);
      if (lane === undefined || !watched(lane) || lane.sessionRef.id !== listed.sessionRef.id) continue;
      const now = d.now();
      if (st === "gone") {
        lane.status = "lost";
        lane.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
        d.store.saveLane(lane);
        void runHook(d, "onLost", { key: lane.key, text: "pane disappeared without READY", evidence: "" });
        await tellLead(d, `[LOST ${lane.key}] pane ${refText(lane.sessionRef)} closed without a final answer`, "duty");
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      if (st === "working") {
        lane.lastActivityAt = now;
        d.store.saveLane(lane);
      }
      if (lane.status === "waiting") continue;
      // The lead hears of a stall whatever the pane is doing: a lane can be busy, blocked or chatty without progress.
      if (stalled(lane, now)) {
        lane.escalatedAt = now;
        lane.log.push({ at: now, kind: "escalate", text: `no new evidence since ${hhmm(progressOf(lane))}` });
        d.store.saveLane(lane);
        await tellLead(d, escalation(lane, st, now), "duty");
        events.push({ lane: lane.key, action: "escalated" });
        continue;
      }
      if (st === "working" || st === "blocked" || st === "error") continue;
      // Nudges answer silence: any report or a working pane restarts the quiet time, but only progress resets the count.
      const quietMin = (now - Math.max(progressOf(lane), lane.lastActivityAt)) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || quietMin < due) continue;
      lane.nudges += 1;
      lane.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(quietMin)} min` });
      d.store.saveLane(lane);
      const since = progressOf(lane);
      await sendOrThrow(
        d,
        lane.key,
        prompt("nudge.md", {
          key: lane.key,
          minutes: String(Math.floor(quietMin)),
          since: hhmm(since),
          age: ageText(now - since),
          dori: d.doriCmd,
        }),
        "duty",
      );
      events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: listed.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  const count = (pred: (a: string) => boolean) => events.filter((e) => pred(e.action)).length;
  d.usage.touch();
  d.usage.duty({
    ticks: 1,
    flushed: count((a) => a === "flushed"),
    nudges: count((a) => a.startsWith("nudge-")),
    escalations: count((a) => a === "escalated"),
    lost: count((a) => a === "lost"),
  });
  return events;
}
