import assert from "node:assert/strict";
import { join } from "node:path";
import { requiredSourceRequest } from "./required-source.ts";

const [boundary, availability] = process.argv.slice(2);
assert(boundary === "session" || boundary === "provider");
assert(["available", "unavailable", "thinking", "thinking-mismatch"].includes(availability ?? ""));
const thinking = availability === "thinking" ? "high" : availability === "thinking-mismatch" ? "low" : undefined;
const available = availability === "available" || availability === "thinking";
const result = await requiredSourceRequest(
  join(import.meta.dir, "../../../extension/index.ts"),
  process.cwd(),
  "lane",
  boundary,
  availability === "unavailable" ? "openai/absent" : `openai/required-source-local${thinking ? ":high" : ""}`,
  thinking,
);
assert.deepEqual(result.errors.filter((error) => error.event === "session_start"), []);
assert.equal(result.requests, available ? 1 : 0);
if (!available) assert(result.errors.some((error) => error.error.includes("STARTUP_MODEL_HOLD")));
