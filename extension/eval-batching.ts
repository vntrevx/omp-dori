/**
 * GPT-6.1 Sol pays a full provider round trip for every model turn, and left alone it spends one turn per lookup.
 * omp's `eval` cell reaches every session tool as `tool.<name>(...)`, so a Dori role session on Sol is told to fan its
 * independent read-only calls out from one cell. Sessions on other models, or without `eval`, are left unchanged.
 */

export interface PromptModel {
  id: string;
  name?: string;
}

const MARKER = "<omp-dori-eval-batching>";
const SOL = /(^|[/@:._\s-])gpt[._\s-]?6(?:[._\s-]1|1)[._\s-]sol(?=$|[/@:._\s-])/i;

export const EVAL_BATCHING = `${MARKER}
## Eval tool batching

Every model turn on this model is a slow provider round trip. When a step needs two or more independent read-only calls (read, grep, glob, find, lsp, ast_grep, read-only bash), make them from one \`eval\` js cell instead of one turn each:

\`\`\`js
const [config, hits] = await Promise.all([
  tool.read({ path: "src/config.ts" }),
  tool.grep({ pattern: "loadConfig", path: "src" }),
]);
\`\`\`

Print only the facts the next decision needs, and keep every failed call visible. Edits, writes, side-effecting commands, approvals, waits, and any call whose input depends on a result you have not seen stay one at a time, each observed before the next.
</omp-dori-eval-batching>`;

export const isSol = (model: PromptModel | undefined): boolean =>
  model !== undefined && (SOL.test(model.id) || (model.name !== undefined && SOL.test(model.name)));

/** The system prompt with the batching block appended, or undefined when it does not apply or is already present. */
export const withEvalBatching = (
  systemPrompt: unknown,
  model: PromptModel | undefined,
  activeTools: readonly string[],
): string[] | undefined => {
  if (!Array.isArray(systemPrompt) || !systemPrompt.every((block) => typeof block === "string")) return undefined;
  if (!isSol(model) || !activeTools.includes("eval")) return undefined;
  if (systemPrompt.some((block: string) => block.includes(MARKER))) return undefined;
  return [...systemPrompt, EVAL_BATCHING];
};
