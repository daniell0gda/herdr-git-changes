// "Generate commit message": one-shot call to a coding agent's CLI with the diff
// in the prompt (exec has no stdin). Pure helpers; panel.js owns the UI and exec.

export const AGENTS = {
  claude: { label: "Claude Code", command: "claude", models: ["", "haiku", "sonnet", "opus"], efforts: ["", "low", "medium", "high"] },
  hermes: { label: "Hermes", command: "hermes", models: [""], efforts: ["", "low", "medium", "high"] },
  codex: { label: "Codex", command: "codex", models: [""], efforts: ["", "low", "medium", "high"] },
};
export const DEFAULT_AI = { agent: "claude", model: "haiku", effort: "" };
export const MAX_DIFF = 12000; // chars; the prompt is an argument, so it must stay under the OS limit

export function normalizeAi(raw) {
  const agent = AGENTS[raw?.agent] ? raw.agent : DEFAULT_AI.agent;
  const a = AGENTS[agent];
  return { agent, model: a.models.includes(raw?.model) ? raw.model : agent === DEFAULT_AI.agent ? DEFAULT_AI.model : a.models[0], effort: a.efforts.includes(raw?.effort) ? raw.effort : "" };
}

export const diffArgs = (mode, hasHead) => (mode === "staged" || !hasHead ? ["diff", "--cached", "--no-color", "-U2"] : ["diff", "HEAD", "--no-color", "-U2"]);

export function buildPrompt(diff, { recent = "" } = {}) {
  const cut = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated]` : diff;
  const lines = [
    "Write a git commit message for the diff below.",
    "Subject line: imperative mood, at most 72 characters, no trailing period.",
    "Add a short body after a blank line only when the change needs it.",
  ];
  if (recent) lines.push(`Match the style of these recent subjects:\n${recent}`);
  lines.push("Reply with the commit message only: no quotes, no code fences, no commentary.", "", cut);
  return lines.join("\n");
}

// The CLI arguments for the chosen agent.
export function agentArgs({ agent, model, effort }, prompt) {
  if (agent === "hermes") return ["-z", prompt, ...(model ? ["-m", model] : []), ...(effort ? ["--reasoning", effort] : [])];
  if (agent === "codex") return ["exec", ...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []), prompt];
  return ["-p", prompt, "--no-session-persistence", ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
}

// Strips fences and wrapping quotes a model adds despite being told not to.
export function cleanMessage(out) {
  let text = String(out ?? "").trim().replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  if (/^(["'`]).*\1$/s.test(text)) text = text.slice(1, -1).trim();
  return text;
}
