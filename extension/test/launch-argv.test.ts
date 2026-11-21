import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type * as NativeArgs from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/cli/args.d.ts";
import type * as NativeFlags from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/cli/flag-tables.d.ts";
import { classifyOmpArgv } from "../../src/runtime/omp-argv.ts";
import { NATIVE_VALUE_FLAGS } from "../../src/runtime/omp-options.ts";
import { NATIVE_BOOLEAN_FLAGS } from "../../src/update/native-argv.ts";
import { modelLaunchCommand, modelLaunchProblem } from "../../skills/dori-mode/scripts/src/launch-model.ts";

// CI has no extension peer: exercise the frozen host module boundary instead of an ambient package import.
const host = resolve(import.meta.dir, "../../test/fixtures/omp-native-host");
const { parseArgs }: typeof NativeArgs = await import(Bun.resolveSync("@oh-my-pi/pi-coding-agent/cli/args", host));
const { STRING_VALUE_FLAGS, VALUELESS_FLAGS }: typeof NativeFlags = await import(
  Bun.resolveSync("@oh-my-pi/pi-coding-agent/cli/flag-tables", host)
);

const source = "/fixture/packages/coding-agent/";
const prefixes = [
  ["omp"],
  ["omp-dori", "omp"],
  ["env", "-i", "--", "omp"],
  ["npm", "exec", "--", "omp"],
  ["npx", "--yes", "@oh-my-pi/pi-coding-agent@19.0.1"],
  ["bun", "run", "--preload=/fixture/hook.ts", "/fixture/omp"],
  ["node", "--no-warnings", "/fixture/omp"],
  ["bun", "--preload", `${source}scripts/omp.ts`, `${source}src/cli.ts`],
  [
    "bun",
    "--preload",
    `${source}scripts/omp.ts`,
    "--preload",
    `${source}scripts/../../utils/src/module-timer.ts`,
    `${source}scripts/../src/cli.ts`,
  ],
];

test("the shared native value table matches the pinned parser", () => {
  expect(Object.keys(NATIVE_VALUE_FLAGS).sort()).toEqual([...STRING_VALUE_FLAGS].sort());
  expect(Object.keys(NATIVE_BOOLEAN_FLAGS).sort()).toEqual([...VALUELESS_FLAGS, "-h", "-v", "-c", "-p"].sort());
});

test.each(prefixes.map((prefix) => [prefix.join(" "), prefix] as const))(
  "native startup preserves the %s entry and has no initial work",
  (_name, prefix) => {
    for (const delimiter of [[], ["--"]]) {
      const template = [
        ...prefix,
        "--dori-role",
        "lane",
        "--model",
        "{model}",
        "--plan",
        "subscription/plan",
        "--append-system-prompt",
        "--flag-looking value",
        "--owner-option=--literal",
        ...delimiter,
        "{prompt}",
      ];
      expect(modelLaunchProblem(template, "subscription/exact")).toBeNull();
      const command = modelLaunchCommand(template, "subscription/exact", "Do not send yet");
      expect(command.slice(0, prefix.length)).toEqual(prefix);
      expect(command[prefix.length]).toBe("--dori-launch-model=subscription/exact");
      const classified = classifyOmpArgv(command);
      if (classified.kind !== "omp") throw new Error("native command was lost");
      const argv = classified.command.slice(classified.argsAt);
      // Native startup parses once before discovering extension flag definitions.
      const early = parseArgs([...argv]);
      expect(early.messages).toEqual([]);
      expect(early.fileArgs).toEqual([]);
      for (const shadow of [false, true]) {
        const flags = new Map<string, { type: "string" | "boolean" }>([
          ["dori-role", { type: "string" }],
          ["dori-launch-model", { type: "string" }],
          ["owner-option", { type: "string" }],
        ]);
        if (shadow) {
          flags.set("model", { type: "boolean" });
          flags.set("plan", { type: "boolean" });
        }
        const parsed = parseArgs([...argv], flags);
        expect(parsed.messages).toEqual([]);
        expect(parsed.fileArgs).toEqual([]);
        expect(parsed.unrecognizedFlags).toEqual([]);
        expect(parsed.unknownFlags.get("dori-launch-model")).toBe("subscription/exact");
        expect(parsed.unknownFlags.get("owner-option")).toBe("--literal");
        expect(parsed.model).toBe(shadow ? undefined : "subscription/exact");
        expect(parsed.appendSystemPrompt).toBe("--flag-looking value");
      }
    }
  },
);

test.each(
  [
    ["early text"],
    ["@/fixture/brief.md"],
    ["--goal", "start now"],
    ["--restore"],
    ["--resume", "/fixture/session.jsonl"],
    ["--owner-option", "ambiguous value"],
    ["--owner-boolean"],
    ["--append-system-prompt"],
  ].map((input) => [input]),
)("initial work or an ambiguous template is refused: %j", (input) => {
  const template = ["omp", "--model", "{model}", ...input, "{prompt}"];
  expect(modelLaunchProblem(template, "subscription/exact")).toContain("\nFix:");
  expect(() => modelLaunchCommand(template, "subscription/exact", "Do not send")).toThrow();
});

test("non-interactive native modes preserve their initial prompt and are refused only in strict mode", () => {
  for (const flags of [
    ["-p"],
    ["--print"],
    ["--print=false"],
    ["--mode=json"],
    ["--mode=rpc"],
    ["--mode=rpc-ui"],
    ["--mode=acp"],
  ]) {
    const template = ["omp", ...flags, "--model", "{model}", "{prompt}"];
    const command = modelLaunchCommand(template, "subscription/exact", "Do the work");
    expect(command).toEqual(["omp", ...flags, "--model", "subscription/exact", "Do the work"]);
    const parsed = parseArgs(command.slice(1));
    expect(parsed.print || (parsed.mode !== undefined && parsed.mode !== "text")).toBe(true);
    expect(parsed.messages).toEqual(["Do the work"]);
    expect(modelLaunchProblem(template, "subscription/exact")).toBeNull();
    expect(modelLaunchProblem(template, "subscription/exact", true)).toContain("\nFix:");
  }
});

test("opaque shell launchers remain compatible unless strict readback is requested", () => {
  const template = ["sh", "-c", 'exec omp "$@"', "agent", "{prompt}"];
  expect(modelLaunchProblem(template, "subscription/exact")).toBeNull();
  expect(modelLaunchCommand(template, "subscription/exact", "Original prompt")).toEqual([
    "sh",
    "-c",
    'exec omp "$@"',
    "agent",
    "Original prompt",
  ]);
  expect(modelLaunchProblem(template, "subscription/exact", true)).toContain("Fix:");
});

test("managed split empty extension values keep their native meaning without initial work", () => {
  const template = [
    "/home/user/.dori/bin/omp",
    "--no-extensions",
    "-e",
    "/fixture/extension",
    "--config",
    "/fixture/omp.yml",
    "--owner-option",
    "",
    "--model",
    "{model}",
    "--",
    "{prompt}",
  ];
  expect(modelLaunchProblem(template, "subscription/exact", true)).toBeNull();
  const command = modelLaunchCommand(template, "subscription/exact", "Not yet");
  const ownerAt = command.indexOf("--owner-option");
  expect(ownerAt).toBeGreaterThan(0);
  expect(command[ownerAt + 1]).toBe("");
  const parsed = parseArgs(
    command.slice(1),
    new Map([
      ["dori-launch-model", { type: "string" as const }],
      ["owner-option", { type: "string" as const }],
    ]),
  );
  expect(parsed.unknownFlags.get("owner-option")).toBe("");
  expect(parsed.model).toBe("subscription/exact");
  expect(parsed.extensions).toEqual(["/fixture/extension"]);
  expect(parsed.config).toEqual(["/fixture/omp.yml"]);
  expect(parsed.messages).toEqual([]);
  expect(parsed.fileArgs).toEqual([]);
});

test("native planning, role, thinking and boolean options survive without an initial message", () => {
  const template = [
    "omp",
    "--model",
    "{model}",
    "--prewalk",
    "--prewalk-into",
    "subscription/walk",
    "--plan-yolo",
    "--plan-yolo-into",
    "subscription/fast",
    "--smol",
    "subscription/small",
    "--thinking",
    "high",
    "--no-lsp",
    "--no-pty",
    "{prompt}",
  ];
  expect(modelLaunchProblem(template, "subscription/exact", true)).toBeNull();
  const parsed = parseArgs(modelLaunchCommand(template, "subscription/exact", "Not yet").slice(1));
  expect(parsed).toMatchObject({
    model: "subscription/exact",
    prewalk: true,
    prewalkInto: "subscription/walk",
    planYolo: true,
    planYoloInto: "subscription/fast",
    smol: "subscription/small",
    thinking: "high",
    noLsp: true,
    noPty: true,
    messages: [],
    fileArgs: [],
  });
});
