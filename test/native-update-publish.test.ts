import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishNativeUpdate } from "../scripts/update-native-omp-publish.ts";
import { prepareNativeUpdate } from "../src/release/native-update.ts";
import { fixtureDependencyFiles, nativeUpdateFixture } from "./native-update-fixture.test.ts";
import { NativeGithubFixture } from "./native-update-publisher-fixture.test.ts";

// POSIX-only: these fixtures require private mode bits, executable shebangs and /bin/sh Git admission.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function candidate(conflict = false) {
  const f = nativeUpdateFixture(roots);
  f.advance("19.0.1", conflict);
  await prepareNativeUpdate(f.source, f.output, f.remote, fixtureDependencyFiles);
  return { ...f, github: new NativeGithubFixture(f.source, f.sourceCommit) };
}

posix("trusted native publisher creates a fixed-file draft and exact-head CI once; repeat is idempotent", async () => {
  const f = await candidate();
  const url = await publishNativeUpdate(f.source, f.output, "1234", f.github.api);
  expect(url).toMatch(/\/pull\/7$/);
  expect(f.github.pull?.["draft"]).toBe(true);
  expect(f.github.dispatched).toBe(true);
  const count = f.github.writes.length;
  expect(await publishNativeUpdate(f.source, f.output, "1234", f.github.api)).toBe(url);
  expect(f.github.writes).toHaveLength(count);
  expect(f.github.writes.filter((call) => call.path.endsWith("/git/blobs"))).toHaveLength(8);
  expect(f.github.writes.some((call) => /merge|reviews|releases|tags/.test(call.path))).toBe(false);
});

posix("stale main and dirty or invalid source identity refuse all publication writes", async () => {
  const f = await candidate();
  f.github.current = "f".repeat(40);
  await expect(publishNativeUpdate(f.source, f.output, "1234", f.github.api)).rejects.toThrow("Main advanced");
  expect(f.github.writes).toHaveLength(0);
  f.github.current = f.sourceCommit;
  writeFileSync(join(f.source, "local.txt"), "preserve local source");
  await expect(publishNativeUpdate(f.source, f.output, "1234", f.github.api)).rejects.toThrow("exact clean");
  expect(f.github.writes).toHaveLength(0);
  rmSync(join(f.source, "local.txt"));
  const path = join(f.output, "candidate.json");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...receipt, sourceCommit: "e".repeat(40) }));
  await expect(publishNativeUpdate(f.source, f.output, "1234", f.github.api)).rejects.toThrow("exact clean");
  expect(f.github.writes).toHaveLength(0);
});

posix(
  "conflict issue preserves exact artifact identity and repeated runs neither duplicate nor resolve it",
  async () => {
    const f = await candidate(true);
    const url = await publishNativeUpdate(f.source, f.output, "1234", f.github.api);
    expect(url).toMatch(/\/issues\/8$/);
    expect(f.github.writes).toHaveLength(1);
    expect(f.github.issues[0]?.["body"]).toContain("/actions/runs/1234/artifacts");
    expect(f.github.issues[0]?.["body"]).toContain("SHA-256");
    expect(await publishNativeUpdate(f.source, f.output, "5678", f.github.api)).toBe(url);
    expect(f.github.writes).toHaveLength(1);
    expect(f.github.branch).toBeUndefined();
  },
);

posix("edited existing branch or foreign pull request is not reused or overwritten", async () => {
  const f = await candidate();
  await publishNativeUpdate(f.source, f.output, "1234", f.github.api);
  const writes = f.github.writes.length;
  f.github.after[0] = { ...f.github.after[0]!, sha: "e".repeat(40) };
  await expect(publishNativeUpdate(f.source, f.output, "1234", f.github.api)).rejects.toThrow("authenticated");
  expect(f.github.writes).toHaveLength(writes);
  const foreign = await candidate();
  await publishNativeUpdate(foreign.source, foreign.output, "1234", foreign.github.api);
  foreign.github.pull!["head"] = { ref: foreign.github.branch, sha: "d".repeat(40), repo: { full_name: "other/repo" } };
  await expect(publishNativeUpdate(foreign.source, foreign.output, "1234", foreign.github.api)).rejects.toThrow(
    "canonical",
  );
});

posix("a closed exact proposal is not reopened or redispatched", async () => {
  const f = await candidate();
  const url = await publishNativeUpdate(f.source, f.output, "1234", f.github.api);
  f.github.pull!["state"] = "closed";
  f.github.dispatched = false;
  const writes = f.github.writes.length;
  expect(await publishNativeUpdate(f.source, f.output, "1234", f.github.api)).toBe(url);
  expect(f.github.writes).toHaveLength(writes);
  expect(f.github.dispatched).toBe(false);
});

posix("publication resumes an exact branch after an interrupted PR creation without duplicating commits", async () => {
  const f = await candidate();
  await expect(
    publishNativeUpdate(f.source, f.output, "1234", async (path, method, body) => {
      if (path.endsWith("/pulls") && method === "POST") throw new Error("Interrupted before creating PR");
      return f.github.api(path, method, body);
    }),
  ).rejects.toThrow("Interrupted");
  expect(f.github.branch).toBeDefined();
  expect(f.github.pull).toBeUndefined();
  expect(await publishNativeUpdate(f.source, f.output, "1234", f.github.api)).toMatch(/\/pull\/7$/);
  expect(f.github.writes.filter((call) => call.path.endsWith("/git/commits"))).toHaveLength(1);
  expect(f.github.writes.filter((call) => call.path.endsWith("/git/refs"))).toHaveLength(1);
});

posix("main advancing after object preparation never creates a branch or PR on stale source", async () => {
  const f = await candidate();
  let reads = 0;
  await expect(
    publishNativeUpdate(f.source, f.output, "1234", async (path, method, body) => {
      if (path.endsWith("/git/ref/heads/main") && ++reads > 1) return { object: { sha: "f".repeat(40) } };
      return f.github.api(path, method, body);
    }),
  ).rejects.toThrow("Main advanced");
  expect(f.github.branch).toBeUndefined();
  expect(f.github.pull).toBeUndefined();
});

posix("branch movement before dispatch never runs CI on a substituted head", async () => {
  const f = await candidate();
  await expect(
    publishNativeUpdate(f.source, f.output, "1234", async (path, method, body) => {
      if (f.github.branch && path.endsWith(`/git/ref/heads/${f.github.branch}`))
        return { object: { sha: "f".repeat(40) } };
      return f.github.api(path, method, body);
    }),
  ).rejects.toThrow("changed before CI");
  expect(f.github.pull?.["draft"]).toBe(true);
  expect(f.github.dispatched).toBe(false);
});
