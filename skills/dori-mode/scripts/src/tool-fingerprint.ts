import { createHash } from "node:crypto";

// A native tool result's content block and details, as omp stores them on the branch and sends them in tool update
// events. Fields are read through optional chaining and checked where they are used.
export type ContentBlock = {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly mimeType?: unknown;
  readonly data?: unknown;
};
export type Details = Readonly<Record<string, unknown>> & {
  readonly async?: { readonly state?: unknown; readonly jobId?: unknown };
  readonly images?: unknown;
};
// omp's OutputMeta (`details.meta`), only the artifact locators it carries.
type Locator = { readonly artifactId?: unknown };
type OutputMeta = {
  readonly truncation?: Locator;
  readonly minimized?: Locator;
  readonly limits?: { readonly columnTruncated?: Locator & { readonly selectorBase?: unknown } };
};

// Native shell run bookkeeping in a bash result's details: when and how it ran, not what it found.
const BASH_RUNTIME: Record<string, true> = {
  wallTimeMs: true,
  wallTimeNoticeEmitted: true,
  timeoutSeconds: true,
  requestedTimeoutSeconds: true,
  timeoutDisabled: true,
  trace: true,
  spotlight: true,
};

/**
 * The text without the wall-time line omp's bash puts first among its notices once a run is long (`wallTimeMs` in
 * details formats it), so a run above that threshold reads as the same run below it. Output before it and the other
 * notices after it are kept.
 */
const withoutWallTime = (text: string, wallTimeMs: unknown): string => {
  if (typeof wallTimeMs !== "number") return text;
  const line = `\n\nWall time: ${(wallTimeMs / 1000).toFixed(2)} seconds`;
  const at = text.lastIndexOf(line);
  if (at === -1) return text;
  const end = at + line.length;
  if (end !== text.length && text[end] !== "\n") return text;
  // A notice line after it opens the notice block in its place; the output notice brings its own blank line.
  return text[end] === "\n" && end + 1 < text.length && text[end + 1] !== "\n"
    ? text.slice(0, at + 2) + text.slice(end + 1)
    : text.slice(0, at) + text.slice(end);
};

type ArtifactIds = { readonly notice: readonly string[]; readonly footer: readonly string[] };
/**
 * The artifact ids omp's output metadata names: those its trailing output notice cites (truncation, cut lines) and
 * those a raw-output footer names (the raw capture, the minimizer's original).
 */
const artifactIds = (meta: OutputMeta | undefined): ArtifactIds => {
  const cut = meta?.limits?.columnTruncated;
  const selector =
    typeof cut?.selectorBase === "string" ? cut.selectorBase.match(/^artifact:\/\/(.+)$/)?.[1] : undefined;
  const ids = (values: unknown[]): string[] =>
    values.filter((value): value is string => typeof value === "string" && value !== "");
  return {
    notice: ids([meta?.truncation?.artifactId, cut?.artifactId, selector]),
    footer: ids([meta?.truncation?.artifactId, meta?.minimized?.artifactId]),
  };
};

const OUTPUT_NOTICE = /^\[(?:Showing |Some lines truncated to |\d+ (?:matches|results) limit reached\b).*\]$/;
const LOCAL_SPILL = "local://.log";
const numberedSpill = (id: unknown): string | undefined =>
  typeof id === "string" && /^\d+$/.test(id) ? `local://${id}.log` : undefined;
const spillSelectorBase = (base: unknown): string | undefined =>
  typeof base === "string" && /^local:\/\/\d+\.log$/.test(base) ? base : undefined;
const rawFooter = (url: string): string => `[raw output: ${url}]`;

/** The text with the artifact locators omp's metadata names emptied where omp writes them; the output is kept. */
const withoutLocators = (text: string, meta: OutputMeta | undefined, name: string, details: Details): string => {
  const ids = artifactIds(meta);
  const footers = new Map<string, string>();
  for (const id of ids.footer) {
    footers.set(rawFooter(`artifact://${id}`), rawFooter("artifact://"));
    const spill = numberedSpill(id);
    if (spill) footers.set(rawFooter(spill), rawFooter(LOCAL_SPILL));
  }
  let out = text;
  const nativeSuffix = (line: string): boolean =>
    line === "" ||
    OUTPUT_NOTICE.test(line) ||
    line === rawFooter("artifact://") ||
    line === rawFooter(LOCAL_SPILL) ||
    footers.has(line) ||
    (name === "bash" &&
      (line === "Ran in a copy of the busy session shell; changes here won't persist." ||
        (typeof details["timeoutSeconds"] === "number" &&
          typeof details["requestedTimeoutSeconds"] === "number" &&
          line.startsWith(
            `Timeout clamped to ${details["timeoutSeconds"]}s (requested ${details["requestedTimeoutSeconds"]}s; `,
          ) &&
          line.endsWith("s)."))));
  // A native footer ends the output body; only other native notices may follow it, never arbitrary output lines.
  for (const [footer, normalized] of footers) {
    let at = out.lastIndexOf(footer);
    while (at > 0 && out[at - 1] !== "\n") at = out.lastIndexOf(footer, at - 1);
    const end = at + footer.length;
    if (at !== -1 && (end === out.length || out[end] === "\n") && out.slice(end).split("\n").every(nativeSuffix))
      out = out.slice(0, at) + normalized + out.slice(end);
  }
  // omp's output notice: one bracketed line after a blank line, last in the result.
  const start = out.lastIndexOf("\n\n[");
  if (start === -1 || !OUTPUT_NOTICE.test(out.slice(start + 2))) return out;
  let notice = out.slice(start);
  for (const id of ids.notice) {
    const locator = new RegExp(`artifact://${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
    notice = notice.replace(locator, "artifact://");
  }
  // OMP 19 writes numbered spills in recovery clauses, not in the rest of the notice (e.g. a report label).
  const truncationSpill = numberedSpill(meta?.truncation?.artifactId);
  const cut = meta?.limits?.columnTruncated;
  const cutSpill = numberedSpill(cut?.artifactId);
  const selector = cut?.selectorBase === undefined ? cutSpill : spillSelectorBase(cut.selectorBase);
  notice = notice.replace(
    /(?<=\. Read )local:\/\/\d+\.log(?= for (?:full (?:output|report)|a head\/tail sample of the output)\b)/g,
    (url) => (url === truncationSpill || url === cutSpill ? LOCAL_SPILL : url),
  );
  notice = notice.replace(/(?<=\. Use )local:\/\/\d+\.log(?=:raw:\d+-\d+ to read line )/g, (url) =>
    url === selector ? LOCAL_SPILL : url,
  );
  return out.slice(0, start) + notice;
};

const metaWithoutLocators = (meta: OutputMeta): OutputMeta => {
  const copy = structuredClone(meta) as {
    truncation?: { artifactId?: unknown };
    minimized?: { artifactId?: unknown };
    limits?: { columnTruncated?: { artifactId?: unknown; selectorBase?: unknown } };
  };
  delete copy.truncation?.artifactId;
  delete copy.minimized?.artifactId;
  const cut = copy.limits?.columnTruncated;
  delete cut?.artifactId;
  if (
    typeof cut?.selectorBase === "string" &&
    (cut.selectorBase.startsWith("artifact://") || spillSelectorBase(cut.selectorBase))
  )
    delete cut.selectorBase;
  return copy;
};

/**
 * The fingerprint of a successful result of tool `name`: its visible content and structured data, without native run
 * timing, async bookkeeping or the artifact locators its output metadata names. Output that only reads like those
 * stays data.
 */
export const resultFingerprint = (
  name: string,
  content: readonly (ContentBlock | null)[],
  details: Details,
): string => {
  const rawMeta = details["meta"];
  const meta = typeof rawMeta === "object" && rawMeta !== null ? (rawMeta as OutputMeta) : undefined;
  const timed = name === "bash" && details["wallTimeNoticeEmitted"] === true;
  const read = content.map((block) => {
    if (block?.type === "image") return { type: "image", mimeType: block.mimeType, data: block.data };
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const text = timed ? withoutWallTime(block.text, details["wallTimeMs"]) : block.text;
    return { type: "text", text: withoutLocators(text, meta, name, details) };
  });
  const kept = Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => key !== "async" && !(name === "bash" && Object.hasOwn(BASH_RUNTIME, key)))
      .map(([key, value]) => {
        if (key === "meta" && meta) return [key, metaWithoutLocators(meta)];
        if (name === "eval" && key === "cells" && Array.isArray(value))
          return [
            key,
            value.map((cell: unknown) =>
              cell !== null && typeof cell === "object"
                ? Object.fromEntries(
                    Object.entries(cell).filter(([field]) => !["durationMs", "title", "code"].includes(field)),
                  )
                : cell,
            ),
          ];
        return [key, value];
      }),
  );
  const payload = JSON.stringify({ toolName: name, content: read, details: kept }, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  return createHash("sha256").update(payload).digest("hex");
};
