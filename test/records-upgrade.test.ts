import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { status } from "../src/cli-up.ts";
import { dutyTick } from "../src/duty.ts";
import { RuntimeChoiceError } from "../src/runtime/select.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { Store } from "../src/store.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

const MIN = 60_000;

// A lanes/<key>.json and a roles.json exactly as a binary from before runtimes existed wrote them.
const OLD_LANE = {
  key: "old-lane",
  paneId: "w1:p3",
  tabId: "w1:t3",
  brief: "/b.md",
  cwd: "/w",
  status: "working",
  createdAt: 1,
  lastActivityAt: 1,
  nudges: 0,
  log: [],
};

function oldHome() {
  const w = new World();
  const d = w.deps();
  const laneFile = join(d.store.root, "lanes", "old-lane.json");
  writeFileSync(laneFile, JSON.stringify(OLD_LANE));
  writeFileSync(
    join(d.store.root, "lanes", "no-tab.json"),
    JSON.stringify({ ...OLD_LANE, key: "no-tab", tabId: "", createdAt: 2 }),
  );
  writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "w1:p1", duty: "w1:p2" }));
  return { w, d, laneFile };
}

describe("records written before runtimes existed (IS-3)", () => {
  test("lane() and lanes() read an old lane as the herdr pane it names; bare roles are herdr refs", () => {
    const { d } = oldHome();
    const want: SessionRef = { runtime: "herdr", id: "w1:p3", container: "w1:t3" };
    const bare: SessionRef = { runtime: "herdr", id: "w1:p3" };
    expect(d.store.lane("old-lane")?.sessionRef).toEqual(want);
    expect(d.store.lanes().map((l) => l.sessionRef)).toEqual([want, bare]);
    expect(d.store.roles()).toEqual({
      lead: { runtime: "herdr", id: "w1:p1" },
      duty: { runtime: "herdr", id: "w1:p2" },
    });
    expect(d.store.laneBySession({ runtime: "herdr", id: "w1:p3" })?.key).toBe("old-lane");
  });

  test("run twice, the result is identical; reading writes nothing, saving keeps paneId/tabId and saves the same bytes again", () => {
    const { d, laneFile } = oldHome();
    const before = readFileSync(laneFile, "utf8");
    const first = { lane: d.store.lane("old-lane"), lanes: d.store.lanes(), roles: d.store.roles() };
    const second = { lane: d.store.lane("old-lane"), lanes: d.store.lanes(), roles: d.store.roles() };
    expect(second).toEqual(first);
    expect(readFileSync(laneFile, "utf8")).toBe(before);
    d.store.saveLane(first.lane!);
    const saved = readFileSync(laneFile, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ paneId: "w1:p3", tabId: "w1:t3", sessionRef: first.lane!.sessionRef });
    d.store.saveLane(d.store.lane("old-lane")!);
    expect(readFileSync(laneFile, "utf8")).toBe(saved);
    expect(d.store.lane("old-lane")).toEqual(first.lane!);
  });

  test("dori status shows the old lane as w1:p3 beside a herdr runtime column, the way it prints roles", async () => {
    const { d } = oldHome();
    const { out } = await captureIo(async () => {
      status(d);
      return 0;
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("RUNTIME herdr (from config)");
    expect(lines[1]).toStartWith("lead=w1:p1 duty=w1:p2 ");
    expect(lines.find((l) => l.startsWith("old-lane"))).toMatch(/^old-lane\s+working\s+herdr\s+w1:p3\s/);
  });

  test("dori status with a long home path and an unset runtime keeps every line within 120 columns, nothing cut", async () => {
    const { d } = oldHome();
    const root = join(d.store.root, `${"deep-home-directory-".repeat(8)}end`);
    const long = {
      ...d,
      store: new Store(root),
      choice: () => {
        throw new RuntimeChoiceError(`neither herdr nor hc is on PATH: set "runtime" in ${join(root, "config.json")}`);
      },
    };
    const { out } = await captureIo(async () => {
      status(long);
      return 0;
    });
    for (const line of out.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
    expect(out.replaceAll("\n", "")).toContain(`home=${root}`);
    expect(out.replace(/\n(?!RUNTIME|lead=)/g, "")).toContain(join(root, "config.json"));
  });

  // The duty loop before the progress clock saved its third nudge before telling the lead, and told nobody when no
  // lead was registered or the delivery failed: a third nudge on record is no proof the lead heard of the stall.
  test("a lane with three nudges from before the progress clock is escalated: no lead then, or a delivery that failed", async () => {
    const nudge = (at: number) => ({ at, kind: "nudge" as const, text: "idle" });
    const oldTold = (rmRoles: boolean) => {
      const home = oldHome();
      rmSync(join(home.d.store.root, "lanes", "no-tab.json"));
      if (rmRoles) rmSync(join(home.d.store.root, "roles.json"));
      const lead = home.w.addPane("w1:p1", "idle");
      home.w.addPane("w1:p3", "idle");
      const lane = home.d.store.lane("old-lane")!;
      home.d.store.saveLane({ ...lane, nudges: 3, log: [nudge(10 * MIN), nudge(20 * MIN), nudge(40 * MIN)] });
      home.w.clock = 90 * MIN;
      return { ...home, lead };
    };
    const none = oldTold(true);
    expect(await dutyTick(none.d)).toContainEqual(
      expect.objectContaining({ lane: "old-lane", action: "escalate-no-lead" }),
    );
    none.d.store.setRole("lead", { runtime: "herdr", id: "w1:p1" });
    expect(await dutyTick(none.d)).toEqual([{ lane: "old-lane", action: "escalated" }]);
    expect(none.lead.received.at(-1)).toStartWith("[ESCALATE old-lane] no new evidence for 1h29m");
    expect(await dutyTick(none.d)).toEqual([]);
    // A lead was registered but the old loop's delivery failed after the third nudge was saved: escalated now, once.
    const failed = oldTold(false);
    expect(await dutyTick(failed.d)).toEqual([{ lane: "old-lane", action: "escalated" }]);
    expect(await dutyTick(failed.d)).toEqual([]);
    expect(failed.lead.received.filter((m) => m.startsWith("[ESCALATE old-lane]"))).toHaveLength(1);
  });
});
