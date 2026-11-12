/** dori usage: per-session token/cost readings for OMP lanes. */
import { type Command, die } from "./cli-context.ts";
import { readSessionUsage } from "./omp-usage.ts";

const usageOmp: Command = async ({ need, config }) => {
  const sessionId = need("session");
  const usage = await readSessionUsage(config.sessionsDir, sessionId).catch((e: unknown): never =>
    die(e instanceof Error ? e.message : String(e)),
  );
  console.log(JSON.stringify({ tokens: usage.tokens, costUsd: usage.costUsd }));
};

const usageCmd: Command = async (cli) => {
  const sub = cli.key ?? die("usage needs omp");
  if (sub !== "omp") die(`usage ${sub} is not supported`);
  await usageOmp(cli);
};

export const usageCommands: Readonly<Record<string, Command>> = { usage: usageCmd };
