// Terminal text helpers: wide (Korean) characters take two columns, and a cut never splits a character.

const graphemes = (text: string): string[] =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);

/** The leading graphemes of `parts` that fit in `cols` columns. */
function keep(parts: readonly string[], cols: number): string[] {
  const out: string[] = [];
  let width = 0;
  for (const g of parts) {
    width += Bun.stringWidth(g);
    if (width > cols) break;
    out.push(g);
  }
  return out;
}

/** `text` cut to `cols` terminal columns from the end, ending in "…" when cut. */
export const fitEnd = (text: string, cols: number): string =>
  Bun.stringWidth(text) <= cols ? text : `${keep(graphemes(text), cols - 1).join("")}…`;

/** `text` cut to `cols` terminal columns from the start, so a long path keeps its file name: "…/dir/file.md". */
export const fitStart = (text: string, cols: number): string =>
  Bun.stringWidth(text) <= cols
    ? text
    : `…${keep(graphemes(text).reverse(), cols - 1)
        .reverse()
        .join("")}`;

/** `text` padded with spaces to `cols` terminal columns (cut first when longer). */
export function padCols(text: string, cols: number): string {
  const fitted = fitEnd(text, cols);
  return fitted + " ".repeat(Math.max(0, cols - Bun.stringWidth(fitted)));
}

/** Local wall-clock time, "19:47". */
export function hhmm(at: number): string {
  const t = new Date(at);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** A duration as a person reads it: "45m", "2h10m", "1d3h". */
export function ageText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${String(min % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}
