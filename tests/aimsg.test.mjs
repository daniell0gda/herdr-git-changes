// Tests the generated-commit-message helpers: settings, the diff to read, the prompt,
// each agent's arguments and the cleanup of its reply. Nothing here needs Herdr, git
// or an agent. Run: node tests/aimsg.test.mjs
import * as AI from "../mods/git-changes/aimsg.js";
import assert from "node:assert/strict";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); process.exitCode = 1; }
};

test("settings fall back to the defaults, and a stored empty model is kept", () => {
  assert.deepEqual(AI.normalizeAi(null), { agent: "claude", model: "haiku", effort: "" });
  assert.deepEqual(AI.normalizeAi({ agent: "nope", model: "x", effort: "y" }), { agent: "claude", model: "haiku", effort: "" });
  assert.deepEqual(AI.normalizeAi({ agent: "claude", model: "", effort: "high" }), { agent: "claude", model: "", effort: "high" });
  assert.deepEqual(AI.normalizeAi({ agent: "hermes", model: "haiku", effort: "low" }), { agent: "hermes", model: "", effort: "low" });
});

test("it reads the staged diff, or every tracked change when nothing is staged", () => {
  assert.deepEqual(AI.diffArgs("staged", true).slice(0, 2), ["diff", "--cached"]);
  assert.deepEqual(AI.diffArgs("tracked", true).slice(0, 2), ["diff", "HEAD"]);
  assert.deepEqual(AI.diffArgs("tracked", false).slice(0, 2), ["diff", "--cached"], "no HEAD to diff against yet");
});

test("the prompt carries the diff, the recent subjects, and is capped", () => {
  const p = AI.buildPrompt("+x", { recent: "Fix a\nAdd b" });
  assert.ok(p.includes("+x") && p.includes("Fix a\nAdd b") && p.includes("commit message only"));
  assert.ok(!AI.buildPrompt("+x").includes("recent subjects"));
  const long = AI.buildPrompt("y".repeat(AI.MAX_DIFF * 2));
  assert.ok(long.includes("[diff truncated]") && long.length < AI.MAX_DIFF + 600);
});

test("each agent gets its own arguments, and empty model and effort add nothing", () => {
  assert.deepEqual(AI.agentArgs({ agent: "claude", model: "haiku", effort: "low" }, "P"), ["-p", "P", "--no-session-persistence", "--model", "haiku", "--effort", "low"]);
  assert.deepEqual(AI.agentArgs({ agent: "claude", model: "", effort: "" }, "P"), ["-p", "P", "--no-session-persistence"]);
  assert.deepEqual(AI.agentArgs({ agent: "hermes", model: "", effort: "high" }, "P"), ["-z", "P", "--reasoning", "high"]);
  assert.deepEqual(AI.agentArgs({ agent: "codex", model: "", effort: "low" }, "P"), ["exec", "-c", 'model_reasoning_effort="low"', "P"]);
});

test("a reply loses the fences and quotes a model adds anyway", () => {
  assert.equal(AI.cleanMessage("Fix the bug\n"), "Fix the bug");
  assert.equal(AI.cleanMessage('"Fix the bug"'), "Fix the bug");
  assert.equal(AI.cleanMessage("```\nFix the bug\n\nBody\n```"), "Fix the bug\n\nBody");
  assert.equal(AI.cleanMessage(null), "");
});

console.log(`${passed} passed`);
