import { createHash } from "node:crypto";
import { RELEASE_REPOSITORY } from "../scripts/release-gate.ts";
import { fixtureGit } from "./source-bundle-setup.ts";

type Entry = { path: string; mode: string; type: string; sha: string };
const hash = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const root = `repos/${RELEASE_REPOSITORY}`;
const tree = "b".repeat(40);
const head = "d".repeat(40);

/** In-memory GitHub transport: no requests, tokens, model calls, or external publication. */
export class NativeGithubFixture {
  readonly writes: { path: string; body: unknown }[] = [];
  readonly before: Entry[];
  readonly baseTree: string;
  after: Entry[] = [];
  current: string;
  branch: string | undefined;
  pull: Record<string, unknown> | undefined;
  issues: Record<string, unknown>[] = [];
  dispatched = false;

  constructor(
    readonly source: string,
    readonly sourceCommit: string,
  ) {
    this.current = sourceCommit;
    this.baseTree = fixtureGit(source, "rev-parse", "HEAD^{tree}");
    this.before = fixtureGit(source, "ls-tree", "-r", "HEAD")
      .split("\n")
      .map((line) => {
        const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line)!;
        return { mode: match[1]!, type: match[2]!, sha: match[3]!, path: match[4]! };
      });
  }

  api = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    if (!path.startsWith(`${root}/`)) throw new Error(`Unexpected repository ${path}`);
    if (method !== "GET") this.writes.push({ path, body });
    const endpoint = path.slice(root.length + 1);
    const data = body as Record<string, unknown>;
    if (endpoint === "git/ref/heads/main") return { object: { sha: this.current } };
    if (endpoint.startsWith("git/matching-refs/heads/"))
      return this.branch ? [{ ref: `refs/heads/${this.branch}`, object: { sha: head } }] : [];
    if (endpoint.startsWith("pulls?")) return this.pull ? [this.pull] : [];
    if (endpoint === "git/blobs" && method === "POST")
      return { sha: hash(Buffer.from(String(data["content"]), "base64")) };
    if (endpoint === "git/trees" && method === "POST") {
      const changes = data["tree"] as Entry[];
      this.after = this.before.map((entry) => {
        const replacement = changes.find((change) => change.path === entry.path);
        return replacement ? { ...replacement } : { ...entry };
      });
      return { sha: tree };
    }
    if (endpoint === "git/commits" && method === "POST") return { sha: head };
    if (endpoint === "git/refs" && method === "POST") {
      this.branch = String(data["ref"]).replace("refs/heads/", "");
      return { ref: data["ref"], object: { sha: head } };
    }
    if (endpoint === `git/commits/${this.sourceCommit}`)
      return { sha: this.sourceCommit, tree: { sha: this.baseTree } };
    if (endpoint === `git/commits/${head}`)
      return { sha: head, tree: { sha: tree }, parents: [{ sha: this.sourceCommit }] };
    if (endpoint === `git/trees/${this.baseTree}?recursive=1`)
      return { sha: this.baseTree, truncated: false, tree: this.before };
    if (endpoint === `git/trees/${tree}?recursive=1`) return { sha: tree, truncated: false, tree: this.after };
    if (endpoint === "pulls" && method === "POST") {
      this.pull = {
        number: 7,
        html_url: `https://github.com/${RELEASE_REPOSITORY}/pull/7`,
        state: "open",
        draft: data["draft"],
        head: { ref: data["head"], sha: head, repo: { full_name: RELEASE_REPOSITORY } },
        base: { ref: data["base"], repo: { full_name: RELEASE_REPOSITORY } },
      };
      return this.pull;
    }
    if (endpoint.startsWith("actions/workflows/ci.yml/runs?"))
      return { workflow_runs: this.dispatched ? [{ head_sha: head }] : [] };
    if (endpoint === `git/ref/heads/${this.branch}`) return { object: { sha: head } };
    if (endpoint === "actions/workflows/ci.yml/dispatches") {
      this.dispatched = true;
      return undefined;
    }
    if (endpoint.startsWith("issues?")) return this.issues;
    if (endpoint === "issues" && method === "POST") {
      const issue = { number: 8, html_url: `https://github.com/${RELEASE_REPOSITORY}/issues/8`, ...data };
      this.issues.push(issue);
      return issue;
    }
    throw new Error(`Unexpected GitHub fixture request ${method} ${path}`);
  };
}
