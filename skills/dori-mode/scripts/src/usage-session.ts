import { type BigIntStats, closeSync, createReadStream, fstatSync, lstatSync, readSync } from "node:fs";
import { createInterface } from "node:readline";
import { openUsageFile, usageFileSignature } from "./usage-file.ts";

export type UsageEntry = {
  readonly id: string;
  readonly at: number;
  readonly tokens: number | null;
  readonly costUsd: number | null;
};
export type SessionUsage = {
  readonly signature: string;
  readonly id: string;
  readonly startedAt: number;
  readonly parent: string | null;
  readonly continuation: string | null;
  readonly seance: boolean;
  readonly entries: readonly UsageEntry[];
  readonly tasks: readonly {
    readonly at: number;
    readonly children: readonly { readonly id: string; readonly zero: boolean }[] | null;
  }[];
  readonly errors: readonly string[];
};

const HEADER_LIMIT = 64 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;
/** An unrelated file contributes only a bounded header, not its message or task records. */
export const readUsageHeader = async (path: string) => {
  const { fd, stat } = openUsageFile(path);
  try {
    const prefix = Buffer.alloc(Math.min(HEADER_LIMIT, Number(stat.size)));
    let used = 0;
    while (used < prefix.length) {
      const count = readSync(fd, prefix, used, prefix.length - used, used);
      if (count === 0) break;
      used += count;
    }
    const bytes = prefix.subarray(0, used);
    const end = BigInt(used) === stat.size ? used : bytes.lastIndexOf(10) + 1;
    if (usageFileSignature(fstatSync(fd, { bigint: true })) !== usageFileSignature(stat))
      throw new Error("session header changed during observation");
    for (const line of bytes.toString("utf8", 0, end).split("\n")) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as Record<string, unknown> | null;
      if (value?.["type"] === "title") continue;
      if (value?.["type"] !== "session" || typeof value["id"] !== "string" || value["id"] === "") break;
      return {
        signature: usageFileSignature(stat),
        id: value["id"],
        parent: typeof value["parentSession"] === "string" ? value["parentSession"] : null,
        continuation: typeof value["continuationOf"] === "string" ? value["continuationOf"] : null,
        seance: typeof value["seanceSource"] === "string" && value["seanceSource"].length > 0,
      };
    }
    throw new Error("session header unavailable");
  } finally {
    closeSync(fd);
  }
};

/** OMP 19.0.1 session-entries.ts: assistant messages and model_usage are separate billed calls.
 * Task result aggregates are deliberately excluded: verified child files supply their own calls.
 * Cache only numeric usage, IDs and timestamps, never conversation content. Changed files are rebuilt,
 * so replacement/truncation and discarded-turn model_usage rewrites cannot retain old spend. */
export const readSessionUsage = async (
  path: string,
  cached?: SessionUsage,
  expected?: string,
): Promise<SessionUsage> => {
  const { fd, stat } = openUsageFile(path);
  try {
    if (expected !== undefined && usageFileSignature(stat) !== expected)
      throw new Error("session changed after header admission");
    if (stat.size === 0n || stat.size > BigInt(FILE_LIMIT)) throw new Error("session file outside usage size limit");
    return await readUsageRecords(path, fd, stat, cached);
  } finally {
    closeSync(fd);
  }
};

const readUsageRecords = async (
  path: string,
  fd: number,
  stat: BigIntStats,
  cached?: SessionUsage,
): Promise<SessionUsage> => {
  const signature = usageFileSignature(stat);
  if (
    cached?.signature === signature &&
    typeof cached.id === "string" &&
    cached.id.length > 0 &&
    (cached.parent === null || typeof cached.parent === "string") &&
    (cached.continuation === null || typeof cached.continuation === "string") &&
    typeof cached.seance === "boolean" &&
    Number.isFinite(cached.startedAt) &&
    Array.isArray(cached.entries) &&
    Array.isArray(cached.tasks) &&
    Array.isArray(cached.errors) &&
    !cached.errors.length &&
    cached.tasks.every(
      (task) =>
        task &&
        Number.isFinite(task.at) &&
        (task.children === null ||
          (Array.isArray(task.children) &&
            task.children.every(
              (child: unknown) =>
                child !== null &&
                typeof child === "object" &&
                "id" in child &&
                typeof child.id === "string" &&
                "zero" in child &&
                typeof child.zero === "boolean",
            ))),
    ) &&
    cached.entries.every(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        Number.isFinite(entry.at) &&
        (entry.tokens === null || (Number.isFinite(entry.tokens) && entry.tokens >= 0)) &&
        (entry.costUsd === null || (Number.isFinite(entry.costUsd) && entry.costUsd >= 0)),
    )
  )
    return cached;
  const entries = new Map<string, UsageEntry>();
  const errors: string[] = [];
  let id = "",
    startedAt = Number.NaN,
    parent: string | null = null,
    continuation: string | null = null,
    seance = false;
  const tasks: { at: number; children: { id: string; zero: boolean }[] | null }[] = [];
  const stream = createReadStream(path, {
    fd,
    autoClose: false,
    encoding: "utf8",
    start: 0,
    end: Number(stat.size) - 1,
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const metric = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid record");
        value = parsed as Record<string, unknown>;
      } catch {
        errors.push("unreadable session record");
        continue;
      }
      if (value["type"] === "session") {
        if (id || typeof value["id"] !== "string") {
          errors.push("invalid session identity");
          continue;
        }
        id = value["id"];
        startedAt = Date.parse(String(value["timestamp"]));
        parent = typeof value["parentSession"] === "string" ? value["parentSession"] : null;
        continuation = typeof value["continuationOf"] === "string" ? value["continuationOf"] : null;
        seance = typeof value["seanceSource"] === "string" && value["seanceSource"].length > 0;
        continue;
      }
      const message = value["message"] as Record<string, unknown> | undefined;
      if (value["type"] === "message" && message?.["role"] === "toolResult" && message["toolName"] === "task") {
        const at = Date.parse(String(value["timestamp"]));
        const details = message["details"] as
          { results?: Record<string, unknown>[]; progress?: Record<string, unknown>[] } | undefined;
        const refs = [
          ...(Array.isArray(details?.results)
            ? details.results.map((ref) => ({ ref, settled: Number.isInteger(ref?.["exitCode"]) }))
            : []),
          ...(Array.isArray(details?.progress)
            ? details.progress.map((ref) => ({
                ref,
                settled: ["completed", "failed", "aborted"].includes(String(ref?.["status"])),
              }))
            : []),
        ];
        const known =
          (Array.isArray(details?.results) || Array.isArray(details?.progress)) &&
          refs.every(({ ref }) => ref && typeof ref["id"] === "string" && ref["id"].length > 0);
        if (Number.isFinite(at))
          tasks.push({
            at,
            children: known
              ? refs.map(({ ref, settled }) => ({
                  id: String(ref["id"]),
                  // Lazy native journals may be absent only when terminal counters prove no calls.
                  zero:
                    settled &&
                    ref["tokens"] === 0 &&
                    ref["requests"] === 0 &&
                    (ref["cost"] === undefined || ref["cost"] === 0) &&
                    ref["usage"] === undefined &&
                    ref["advisor"] === undefined,
                }))
              : null,
          });
        else errors.push("task result has no timestamp");
      }
      const own = value["type"] === "model_usage" || (value["type"] === "message" && message?.["role"] === "assistant");
      if (!own) continue;
      const usage = (value["type"] === "model_usage" ? value["usage"] : message?.["usage"]) as
        Record<string, unknown> | undefined;
      const cost = usage?.["cost"] as Record<string, unknown> | undefined;
      const input = metric(usage?.["input"]),
        output = metric(usage?.["output"]),
        cacheWrite = metric(usage?.["cacheWrite"]);
      const entry: UsageEntry = {
        id: typeof value["id"] === "string" ? value["id"] : "",
        at: Date.parse(String(value["timestamp"])),
        tokens: input === null || output === null || cacheWrite === null ? null : metric(input + output + cacheWrite),
        costUsd: metric(cost?.["total"]),
      };
      if (!entry.id || !Number.isFinite(entry.at)) {
        errors.push("usage record has no identity or timestamp");
        continue;
      }
      const previous = entries.get(entry.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
        errors.push("conflicting usage record identity");
      entries.set(entry.id, entry);
    }
  } finally {
    lines.close();
  }
  if (!id || !Number.isFinite(startedAt)) errors.push("session header unavailable");
  const after = lstatSync(path, { bigint: true });
  if (usageFileSignature(after) !== signature || usageFileSignature(fstatSync(fd, { bigint: true })) !== signature)
    errors.push("session changed during observation");
  return {
    signature,
    id,
    startedAt,
    parent,
    continuation,
    seance,
    entries: [...entries.values()],
    tasks,
    errors: [...new Set(errors)],
  };
};
