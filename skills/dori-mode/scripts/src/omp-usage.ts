import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

export type OmpUsage = { readonly tokens: number; readonly costUsd: number };

/**
 * Sum totalTokens and cost.total from an OMP session JSONL string.
 * Sources:
 *   - type=message, message.role=assistant → message.usage.totalTokens + message.usage.cost.total
 *   - type=model_usage → usage.totalTokens + usage.cost.total
 * Skips any line that cannot be parsed (including a torn last line from a mid-write crash).
 */
export const sumUsageFromJsonl = (content: string): OmpUsage => {
  let tokens = 0;
  let costUsd = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // torn or malformed line — skip without failing the whole read
    }
    if (typeof obj !== "object" || obj === null) continue;
    const r = obj as Record<string, unknown>;
    if (r["type"] === "message") {
      const msg = r["message"];
      if (typeof msg !== "object" || msg === null) continue;
      const m = msg as Record<string, unknown>;
      if (m["role"] !== "assistant") continue;
      const usage = m["usage"];
      if (typeof usage !== "object" || usage === null) continue;
      const u = usage as Record<string, unknown>;
      tokens += (u["totalTokens"] as number | undefined) ?? 0;
      const cost = u["cost"];
      if (typeof cost === "object" && cost !== null) {
        costUsd += ((cost as Record<string, unknown>)["total"] as number | undefined) ?? 0;
      }
    } else if (r["type"] === "model_usage") {
      const usage = r["usage"];
      if (typeof usage !== "object" || usage === null) continue;
      const u = usage as Record<string, unknown>;
      tokens += (u["totalTokens"] as number | undefined) ?? 0;
      const cost = u["cost"];
      if (typeof cost === "object" && cost !== null) {
        costUsd += ((cost as Record<string, unknown>)["total"] as number | undefined) ?? 0;
      }
    }
  }
  return { tokens, costUsd };
};

/**
 * Find the JSONL file for a session under sessionsDir using the naming pattern
 * `<timestamp>_<sessionId>.jsonl` (may be nested under a cwd-keyed subdirectory).
 */
export const findSessionFile = async (sessionsDir: string, sessionId: string): Promise<string | undefined> => {
  for await (const rel of new Glob(`**/*_${sessionId}.jsonl`).scan({ cwd: sessionsDir, onlyFiles: true })) {
    return join(sessionsDir, rel);
  }
  return undefined;
};

/** Read cumulative token/cost usage for a session. Throws if the file cannot be found or read. */
export const readSessionUsage = async (sessionsDir: string, sessionId: string): Promise<OmpUsage> => {
  const file = await findSessionFile(sessionsDir, sessionId);
  if (file === undefined) throw new Error(`session ${sessionId} not found under sessionsDir`);
  return sumUsageFromJsonl(readFileSync(file, "utf8"));
};
