import { classifyOmpArgv, mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { NATIVE_VALUE_FLAGS } from "../../../../src/runtime/omp-options.ts";
import { NATIVE_BOOLEAN_FLAGS, RESUME_FLAG } from "../../../../src/update/native-argv.ts";
import { fill } from "./config.ts";
import { exactModelIdentity, type ModelReadback } from "./lane-state.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { runtimesOf } from "./run.ts";
import { ProcessTableUnavailableError, trustedPaneState } from "./session-id.ts";
import { sendVerified, UnsafeTextError } from "./sessions.ts";

/** Keep wrapper/bootstrap arguments verbatim; native values are atomic even if an extension shadows their flag. */
const idleOmpCommand = (template: readonly string[]): string[] | string => {
  const parsed = classifyOmpArgv(template);
  if (parsed.kind !== "omp")
    return "OMP agentCommand is opaque.\nFix: use an explicit OMP executable, source launcher or package-runner argv.";
  const prompts = template.filter((part) => part.includes("{prompt}"));
  if (prompts.length !== 1 || prompts[0] !== "{prompt}")
    return "OMP agentCommand requires one standalone {prompt}.\nFix: put {prompt} in exactly one separate argv element.";
  const at = template.length - parsed.command.length + parsed.argsAt;
  const command = [...template.slice(0, at), "--dori-launch-model={model}"];
  for (let i = at; i < template.length; i++) {
    const arg = template[i]!;
    if (arg === "{prompt}") continue;
    if (arg === "--") {
      if (template.slice(i + 1).some((part) => part !== "{prompt}"))
        return "OMP agentCommand cannot contain initial messages besides {prompt}.\nFix: keep only {prompt} after the native -- separator.";
      break;
    }
    if (arg.startsWith("--dori-launch-model"))
      return "OMP agentCommand cannot preconfigure --dori-launch-model.\nFix: remove this controller-owned option from the template.";
    if (RESUME_FLAG.test(arg) || /^--goal(?:=|$)/.test(arg))
      return "OMP launch requires a fresh idle session.\nFix: remove startup goal and resume options; put the task in the brief.";
    if (!arg.startsWith("-"))
      return "OMP agentCommand has an initial message or ambiguous value.\nFix: put initial text in the brief and attach extension option values with =.";
    if (arg.includes("=")) {
      command.push(arg);
      continue;
    }
    if (NATIVE_VALUE_FLAGS[arg] === true || ["--profile", "--alias", "--dori-role"].includes(arg)) {
      const value = template[++i];
      if (value === undefined || value === "{prompt}")
        return `OMP ${arg} requires its own value.\nFix: supply that option's value before the separate {prompt} argument.`;
      command.push(`${arg === "-e" ? "--extension" : arg}=${value}`);
    } else if (NATIVE_BOOLEAN_FLAGS[arg] === true) command.push(arg);
    else if (template[i + 1] === "") {
      command.push(arg, "");
      i++;
    } else
      return `OMP extension option ${arg} is ambiguous.\nFix: attach its actual value with = (use =true for a boolean option).`;
  }
  return command;
};

const unavailableReason = (template: readonly string[]): string | undefined => {
  const parsed = classifyOmpArgv(template);
  if (parsed.kind !== "omp")
    return "Opaque agentCommand: the native argument boundary cannot be located before its initial prompt";
  const prepared = idleOmpCommand(template);
  if (typeof prepared === "string") return undefined;
  const args = prepared.slice(template.length - parsed.command.length + parsed.argsAt + 1);
  const mode = args.findLast((arg) => arg.startsWith("--mode="))?.slice(7);
  if (args.some((arg) => arg === "-p" || /^--print(?:=|$)/.test(arg)) || (mode !== undefined && mode !== "text"))
    return "Non-interactive agentCommand: verified typed delivery requires an interactive native session";
  return undefined;
};

export const modelLaunchProblem = (
  command: readonly string[],
  model: string,
  requireModelReadback = false,
): string | null => {
  if (!mayRunOmpArgv(command)) return null;
  const unavailable = unavailableReason(command);
  if (unavailable)
    return requireModelReadback
      ? `${unavailable}\nFix: use an explicit OMP executable in interactive text mode without --print or a non-text --mode.`
      : null;
  if (!exactModelIdentity(model))
    return "OMP launch requires one exact provider/model, not an alias, list or wildcard.\nFix: select the full provider/id from the native model catalog.";
  const prepared = idleOmpCommand(command);
  return typeof prepared === "string" ? prepared : null;
};

export const unavailableLaunchModel = (
  template: readonly string[],
  model: string,
  checkedAt: string,
  route: "terminal" | "headless" = "terminal",
): ModelReadback | undefined => {
  const reason =
    route === "headless"
      ? "Headless agentCommand: native catalog readback is unavailable on the RPC kickoff route"
      : mayRunOmpArgv(template)
        ? unavailableReason(template)
        : undefined;
  return reason
    ? {
        requested: exactModelIdentity(model),
        observed: null,
        status: "unavailable",
        billing: "unknown",
        checkedAt,
        source: "launch-preflight",
        reason,
      }
    : undefined;
};

export const modelLaunchCommand = (template: readonly string[], model: string, prompt: string): string[] => {
  if (!mayRunOmpArgv(template) || unavailableReason(template)) return fill(template, { model, prompt });
  const command = idleOmpCommand(template);
  if (typeof command === "string") throw new Error(command);
  return fill(command, { model, prompt });
};

/** A live native readback precedes the first prompt; an uncertain send is never retried. */
export const deliverModelBrief = async (
  deps: FlowDeps,
  ref: SessionRef,
  model: string,
  prompt: string,
  launchedAt: number,
): Promise<string | null> => {
  const rts = runtimesOf(deps);
  let state: Awaited<ReturnType<typeof trustedPaneState>>;
  try {
    state = await trustedPaneState(deps.run, deps.config.stateDir, ref, rts, true);
  } catch (error) {
    if (error instanceof ProcessTableUnavailableError) return "process table unavailable; brief not sent";
    throw error;
  }
  const proof = state?.modelReadback;
  // A thinking-suffixed selection reads back as its base model plus the live native level.
  const level = proof?.thinking;
  const selected = level ? model.slice(0, -level.requested.length - 1) : model;
  if (
    state?.role !== "lane" ||
    state.approvalPending ||
    state.agentStatus !== "idle" ||
    !(Date.parse(state.startedAt) >= launchedAt)
  )
    return "no idle current-launch native session; brief not sent";
  if (
    proof?.source !== "native-extension" ||
    proof.status !== "matched" ||
    `${proof.requested?.provider}/${proof.requested?.id}` !== model ||
    `${proof.observed?.provider}/${proof.observed?.id}`.toLowerCase() !== selected.toLowerCase() ||
    (level !== undefined && (level.observed !== level.requested || !model.endsWith(`:${level.requested}`))) ||
    !(Date.parse(proof.checkedAt) >= launchedAt)
  )
    return `native model ${proof?.status ?? "unknown"}; brief not sent; no automatic substitution`;
  try {
    const delivery = await sendVerified(rts, deps.clock, ref, prompt, "idle", state.sessionId, true);
    return delivery === "delivered" ? null : `brief delivery ${delivery}; do not resend without native evidence`;
  } catch (error) {
    if (error instanceof UnsafeTextError) return `${error.message}; brief not sent`;
    throw error;
  }
};
