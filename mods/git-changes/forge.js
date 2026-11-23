// GitHub and GitLab adapter for git-changes: detects the forge from the
// repository's remote URL and delegates to the user's `gh` or `glab` CLI
// (no tokens stored in the mod). Pure parsers live alongside thin exec helpers
// so everything can be unit-tested without network or Herdr.

const HOST_GITHUB = /(^|\.)github\./i;
const HOST_GITLAB = /(^|\.)gitlab\./i;

/**
 * Parses a git remote URL into `{ kind, host, repo, label, singular }`, or null
 * when the URL isn't a recognized GitHub or GitLab remote.
 * Supports SSH (`git@host:org/repo.git`, `ssh://git@host/org/sub/repo.git`) and
 * HTTPS (`https://host/org/repo.git`).
 */
export function parseRemote(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  let host = "", path = "";
  const scp = raw.match(/^(?:[^@]+@)?([^:/\s]+):(.+)$/);
  if (scp && !raw.includes("://")) {
    [, host, path] = scp;
  } else {
    const m = raw.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/(.+)$/i);
    if (!m) return null;
    [, host, path] = m;
  }
  const repo = path.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !repo || !repo.includes("/")) return null;
  const kind = HOST_GITHUB.test(host) ? "github" : HOST_GITLAB.test(host) ? "gitlab" : null;
  if (!kind) return null;
  return {
    kind,
    host: host.toLowerCase(),
    repo,
    cli: kind === "github" ? "gh" : "glab",
    label: kind === "github" ? "PRs" : "MRs",
    singular: kind === "github" ? "PR" : "MR",
  };
}

/** Picks the best forge remote URL from `git remote -v` output (origin first). */
export function detectForgeFromRemotes(stdout) {
  const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const byName = new Map();
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(\S+)/);
    if (m && !byName.has(m[1])) byName.set(m[1], m[2]);
  }
  const ordered = [byName.get("origin"), ...byName.values()].filter(Boolean);
  for (const url of ordered) {
    const found = parseRemote(url);
    if (found) return found;
  }
  return null;
}

const ciBucket = (status, conclusion) => {
  const s = String(status ?? "").toLowerCase();
  const c = String(conclusion ?? "").toLowerCase();
  if (["in_progress", "queued", "pending", "waiting", "running", "created", "preparing"].includes(s)) return "running";
  if (["failure", "failed", "timed_out", "cancelled", "canceled", "action_required", "startup_failure", "error"].includes(c || s)) return "fail";
  if (["success", "passed", "neutral", "skipped", "completed"].includes(c || s)) return "pass";
  return "none";
};

/** Summarizes a list of normalized `{ name, state, url, workflow }` jobs into `{ state, summary, jobs }`. */
export function summarizeChecks(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) return { state: "none", summary: "No CI runs", jobs: [] };
  const failed = list.filter((j) => j.state === "fail");
  const running = list.filter((j) => j.state === "running");
  const passed = list.filter((j) => j.state === "pass");
  if (failed.length) return { state: "fail", summary: `${failed.length} failed · ${passed.length}/${list.length} passed`, jobs: list };
  if (running.length) return { state: "running", summary: `${running.length} running · ${passed.length}/${list.length} passed`, jobs: list };
  return { state: "pass", summary: `${passed.length}/${list.length} passed`, jobs: list };
}

export function parseGitHubCheckRuns(json) {
  const parsed = JSON.parse(json || "[]");
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.check_runs) ? parsed.check_runs : [];
  const jobs = list.map((c) => {
    const url = c.html_url || c.details_url || "";
    const runMatch = url.match(/\/actions\/runs\/(\d+)/);
    return {
      id: c.id ?? null,
      runId: runMatch ? runMatch[1] : null,
      name: c.name || "Check",
      state: ciBucket(c.status, c.conclusion),
      url,
      summary: c.output?.summary || c.output?.title || "",
    };
  });
  return summarizeChecks(jobs);
}

export function parseGitHubRuns(json) {
  const runs = JSON.parse(json || "[]");
  const jobs = (Array.isArray(runs) ? runs : [])
    .filter((r) => (r.workflowName || r.name || r.displayTitle) && r.displayTitle !== "(Unknown event)")
    .map((r) => ({
      id: null,
      runId: r.databaseId ? String(r.databaseId) : null,
      name: r.workflowName || r.name || r.displayTitle || "Workflow",
      title: r.displayTitle || r.name || "",
      state: ciBucket(r.status, r.conclusion),
      url: r.url || "",
    }));
  return summarizeChecks(jobs);
}

export function parseGitHubChecks(rollup) {
  const items = Array.isArray(rollup) ? rollup : [];
  return items.map((c) => ({
    name: c.name || c.context || c.workflowName || "Check",
    state: ciBucket(c.status || c.state, c.conclusion || c.state),
    url: c.detailsUrl || c.targetUrl || "",
  }));
}

export function parseGitLabPipeline(pipelineJson, jobsJson = "[]") {
  const list = JSON.parse(pipelineJson || "[]");
  const pipe = Array.isArray(list) ? list[0] : list;
  if (!pipe) return { state: "none", summary: "No CI runs", jobs: [] };
  const rawJobs = JSON.parse(jobsJson || "[]");
  const jobs = Array.isArray(rawJobs) && rawJobs.length
    ? rawJobs.map((j) => ({ id: j.id ?? null, name: j.name || j.stage || "Job", state: ciBucket(j.status, j.status), url: j.web_url || "" }))
    : [{ id: null, name: `Pipeline #${pipe.id}`, state: ciBucket(pipe.status, pipe.status), url: pipe.web_url || "" }];
  return summarizeChecks(jobs);
}

const loginOf = (u) => (typeof u === "string" ? u : u?.login || u?.username || u?.name || "");

export function parseGitHubReviews(json) {
  const list = JSON.parse(json || "[]");
  return (Array.isArray(list) ? list : []).map((pr) => {
    const checks = parseGitHubChecks(pr.statusCheckRollup);
    const ci = summarizeChecks(checks);
    return {
      kind: "review",
      number: pr.number,
      title: pr.title || "",
      state: pr.isDraft ? "draft" : String(pr.state || "open").toLowerCase(),
      draft: Boolean(pr.isDraft),
      author: loginOf(pr.author),
      assignees: (pr.assignees ?? []).map(loginOf).filter(Boolean),
      reviewers: (pr.reviewRequests ?? []).map((r) => loginOf(r.login ? r : r.requestedReviewer ?? r)).filter(Boolean),
      labels: (pr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
      reviewState: String(pr.reviewDecision || "").toLowerCase(),
      head: pr.headRefName || "",
      base: pr.baseRefName || "",
      updatedAt: pr.updatedAt || "",
      url: pr.url || "",
      ciState: ci.state,
      commentCount: Array.isArray(pr.comments) ? pr.comments.length : Number(pr.comments?.totalCount ?? 0),
    };
  });
}

export function parseGitLabReviews(json) {
  const list = JSON.parse(json || "[]");
  return (Array.isArray(list) ? list : []).map((mr) => ({
    kind: "review",
    number: mr.iid ?? mr.number,
    title: mr.title || "",
    state: mr.draft || mr.work_in_progress ? "draft" : String(mr.state || "opened").toLowerCase(),
    draft: Boolean(mr.draft || mr.work_in_progress),
    author: loginOf(mr.author),
    assignees: (mr.assignees ?? (mr.assignee ? [mr.assignee] : [])).map(loginOf).filter(Boolean),
    reviewers: (mr.reviewers ?? []).map(loginOf).filter(Boolean),
    labels: (mr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    reviewState: mr.approved ? "approved" : "",
    head: mr.source_branch || "",
    base: mr.target_branch || "",
    updatedAt: mr.updated_at || "",
    url: mr.web_url || "",
    ciState: ciBucket(mr.head_pipeline?.status, mr.head_pipeline?.status),
    commentCount: Number(mr.user_notes_count ?? 0),
  }));
}

export function parseGitHubReviewDetail(prJson, inlineJson = "[]") {
  const pr = JSON.parse(prJson || "{}");
  const inline = JSON.parse(inlineJson || "[]");
  const reviewMap = new Map();
  for (const req of pr.reviewRequests ?? []) {
    const login = loginOf(req.login ? req : req.requestedReviewer ?? req);
    if (login) reviewMap.set(login, "requested");
  }
  for (const rev of pr.reviews ?? []) {
    const login = loginOf(rev.author);
    if (login && rev.state) reviewMap.set(login, String(rev.state).toLowerCase());
  }
  const general = (pr.comments ?? []).map((c) => ({
    author: loginOf(c.author),
    body: c.body || "",
    createdAt: c.createdAt || "",
    path: null,
    line: null,
  }));
  const reviewComments = (Array.isArray(inline) ? inline : []).map((c) => ({
    author: loginOf(c.user),
    body: c.body || "",
    createdAt: c.created_at || "",
    path: c.path || null,
    line: c.line ?? c.original_line ?? null,
  }));
  const comments = [...general, ...reviewComments].sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  return {
    kind: "review",
    number: pr.number,
    title: pr.title || "",
    body: pr.body || "",
    state: pr.isDraft ? "draft" : String(pr.state || "open").toLowerCase(),
    draft: Boolean(pr.isDraft),
    url: pr.url || "",
    author: loginOf(pr.author),
    assignees: (pr.assignees ?? []).map(loginOf).filter(Boolean),
    reviewers: [...reviewMap.entries()].map(([login, state]) => ({ login, state })),
    labels: (pr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    head: pr.headRefName || "",
    base: pr.baseRefName || "",
    updatedAt: pr.updatedAt || "",
    checks: parseGitHubChecks(pr.statusCheckRollup),
    comments,
    files: (pr.files ?? []).map((f) => ({ path: f.path, additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })),
  };
}

export function parseGitLabReviewDetail(mrJson, notesJson = "[]") {
  const mr = JSON.parse(mrJson || "{}");
  const discussions = JSON.parse(notesJson || "[]");
  const comments = [];
  for (const d of Array.isArray(discussions) ? discussions : []) {
    const notes = Array.isArray(d.notes) ? d.notes : [d];
    for (const n of notes) {
      if (n.system) continue;
      comments.push({
        author: loginOf(n.author),
        body: n.body || "",
        createdAt: n.created_at || "",
        path: n.position?.new_path || n.position?.old_path || null,
        line: n.position?.new_line ?? n.position?.old_line ?? null,
      });
    }
  }
  const pipe = mr.head_pipeline ?? mr.pipeline;
  const checks = pipe ? [{ name: `Pipeline #${pipe.id ?? ""}`.trim(), state: ciBucket(pipe.status, pipe.status), url: pipe.web_url || "" }] : [];
  return {
    kind: "review",
    number: mr.iid ?? mr.number,
    title: mr.title || "",
    body: mr.description || "",
    state: mr.draft || mr.work_in_progress ? "draft" : String(mr.state || "opened").toLowerCase(),
    draft: Boolean(mr.draft || mr.work_in_progress),
    url: mr.web_url || "",
    author: loginOf(mr.author),
    assignees: (mr.assignees ?? (mr.assignee ? [mr.assignee] : [])).map(loginOf).filter(Boolean),
    reviewers: (mr.reviewers ?? []).map((r) => ({ login: loginOf(r), state: "requested" })).filter((r) => r.login),
    labels: (mr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    head: mr.source_branch || "",
    base: mr.target_branch || "",
    updatedAt: mr.updated_at || "",
    checks,
    comments,
    files: (mr.changes ?? []).map((f) => ({ path: f.new_path || f.old_path, additions: 0, deletions: 0 })),
  };
}

export function parseGitHubIssues(json) {
  const list = JSON.parse(json || "[]");
  return (Array.isArray(list) ? list : []).map((it) => ({
    kind: "issue",
    number: it.number,
    title: it.title || "",
    state: String(it.state || "open").toLowerCase(),
    author: loginOf(it.author),
    assignees: (it.assignees ?? []).map(loginOf).filter(Boolean),
    labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    updatedAt: it.updatedAt || "",
    url: it.url || "",
    commentCount: Array.isArray(it.comments) ? it.comments.length : Number(it.comments?.totalCount ?? 0),
  }));
}

export function parseGitLabIssues(json) {
  const list = JSON.parse(json || "[]");
  return (Array.isArray(list) ? list : []).map((it) => ({
    kind: "issue",
    number: it.iid ?? it.number,
    title: it.title || "",
    state: String(it.state || "opened").toLowerCase(),
    author: loginOf(it.author),
    assignees: (it.assignees ?? (it.assignee ? [it.assignee] : [])).map(loginOf).filter(Boolean),
    labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    updatedAt: it.updated_at || "",
    url: it.web_url || "",
    commentCount: Number(it.user_notes_count ?? 0),
  }));
}

export function parseGitHubIssueDetail(json) {
  const it = JSON.parse(json || "{}");
  return {
    kind: "issue",
    number: it.number,
    title: it.title || "",
    body: it.body || "",
    state: String(it.state || "open").toLowerCase(),
    url: it.url || "",
    author: loginOf(it.author),
    assignees: (it.assignees ?? []).map(loginOf).filter(Boolean),
    labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    updatedAt: it.updatedAt || "",
    comments: (it.comments ?? []).map((c) => ({ author: loginOf(c.author), body: c.body || "", createdAt: c.createdAt || "", path: null, line: null })),
  };
}

export function parseGitLabIssueDetail(json, notesJson = "[]") {
  const it = JSON.parse(json || "{}");
  const notes = JSON.parse(notesJson || "[]");
  return {
    kind: "issue",
    number: it.iid ?? it.number,
    title: it.title || "",
    body: it.description || "",
    state: String(it.state || "opened").toLowerCase(),
    url: it.web_url || "",
    author: loginOf(it.author),
    assignees: (it.assignees ?? (it.assignee ? [it.assignee] : [])).map(loginOf).filter(Boolean),
    labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    updatedAt: it.updated_at || "",
    comments: (Array.isArray(notes) ? notes : []).filter((n) => !n.system).map((n) => ({
      author: loginOf(n.author), body: n.body || "", createdAt: n.created_at || "", path: null, line: null,
    })),
  };
}

// --- CLI command builders ----------------------------------------------------

const GH_PR_LIST_FIELDS = "number,title,state,isDraft,author,assignees,reviewRequests,reviewDecision,headRefName,baseRefName,updatedAt,url,statusCheckRollup,comments,labels";
const GH_PR_VIEW_FIELDS = `${GH_PR_LIST_FIELDS},body,reviews,files`;
const GH_ISSUE_FIELDS = "number,title,state,author,assignees,labels,updatedAt,url,comments";
const GH_RUN_FIELDS = "databaseId,displayTitle,name,status,conclusion,url,workflowName,updatedAt";

export const reviewListArgs = (forge, state = "open") => (forge.kind === "github"
  ? ["pr", "list", "--state", state, "--limit", "30", "--json", GH_PR_LIST_FIELDS]
  : ["mr", "list", ...(state === "closed" ? ["--closed"] : []), "--output", "json"]);

export const issueListArgs = (forge, state = "open") => (forge.kind === "github"
  ? ["issue", "list", "--state", state, "--limit", "30", "--json", GH_ISSUE_FIELDS]
  : ["issue", "list", ...(state === "closed" ? ["--closed"] : []), "--output", "json"]);

export const ciArgs = (forge, branch, oid = null) => (forge.kind === "github"
  ? (oid ? ["api", `repos/${forge.repo}/commits/${oid}/check-runs`] : ["run", "list", "--branch", branch, "--limit", "5", "--json", GH_RUN_FIELDS])
  : ["api", `projects/:fullpath/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`]);

function cliError(forge, err) {
  const msg = String(err?.stderr || err?.message || err || "").trim();
  if (/ENOENT|not found|No such file/i.test(msg)) {
    return forge.kind === "github"
      ? "gh CLI not found — install GitHub CLI and run `gh auth login`"
      : "glab CLI not found — install GitLab CLI and run `glab auth login`";
  }
  return msg || `${forge.cli} failed`;
}

async function runCli(execFn, forge, args, opts) {
  let r;
  try { r = await execFn(forge.cli, args, { timeout: 20000, ...opts }); }
  catch (e) { throw new Error(cliError(forge, e)); }
  if (r.code !== 0) throw new Error(cliError(forge, r));
  return r.stdout;
}

export async function loadBranchCi(execFn, forge, branch, opts, oid = null) {
  if (!forge || !branch) return { state: "none", summary: "No CI runs", jobs: [] };
  if (forge.kind === "github") {
    if (oid) {
      const checksOut = await runCli(execFn, forge, ciArgs(forge, branch, oid), opts).catch(() => null);
      if (checksOut) {
        const parsed = parseGitHubCheckRuns(checksOut);
        if (parsed.jobs.length) return parsed;
      }
      const commitRuns = await runCli(execFn, forge, ["run", "list", "--commit", oid, "--limit", "5", "--json", GH_RUN_FIELDS], opts).catch(() => "[]");
      return parseGitHubRuns(commitRuns);
    }
    const out = await runCli(execFn, forge, ciArgs(forge, branch), opts);
    return parseGitHubRuns(out);
  }
  const pipeOut = await runCli(execFn, forge, ciArgs(forge, branch), opts);
  const pipes = JSON.parse(pipeOut || "[]");
  const pipe = Array.isArray(pipes) ? pipes[0] : null;
  if (!pipe?.id) return { state: "none", summary: "No CI runs", jobs: [] };
  const jobsOut = await runCli(execFn, forge, ["api", `projects/:fullpath/pipelines/${pipe.id}/jobs`], opts).catch(() => "[]");
  return parseGitLabPipeline(pipeOut, jobsOut);
}

/** Fetches the tail of a failed/completed CI job log (up to ~200 lines) for inline inspection. */
export async function loadJobLog(execFn, forge, job, opts) {
  if (!forge || !job) return "";
  let raw = "";
  if (forge.kind === "github") {
    if (job.runId) raw = await runCli(execFn, forge, ["run", "view", String(job.runId), "--log-failed"], opts).catch(() => "");
    if (!raw && job.id) raw = await runCli(execFn, forge, ["api", `repos/${forge.repo}/actions/jobs/${job.id}/logs`], opts).catch(() => "");
  } else if (job.id) {
    raw = await runCli(execFn, forge, ["api", `projects/:fullpath/jobs/${job.id}/trace`], opts).catch(() => "");
  }
  const clean = String(raw || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
  const lines = clean.split("\n");
  return lines.length > 200 ? `… (${lines.length - 200} earlier lines omitted)\n${lines.slice(-200).join("\n")}` : clean;
}

export async function listReviews(execFn, forge, state, opts) {
  const out = await runCli(execFn, forge, reviewListArgs(forge, state), opts);
  return forge.kind === "github" ? parseGitHubReviews(out) : parseGitLabReviews(out);
}

export async function listIssues(execFn, forge, state, opts) {
  const out = await runCli(execFn, forge, issueListArgs(forge, state), opts);
  return forge.kind === "github" ? parseGitHubIssues(out) : parseGitLabIssues(out);
}

export async function loadReviewDetail(execFn, forge, number, opts) {
  if (forge.kind === "github") {
    const [prOut, inlineOut] = await Promise.all([
      runCli(execFn, forge, ["pr", "view", String(number), "--json", GH_PR_VIEW_FIELDS], opts),
      runCli(execFn, forge, ["api", `repos/${forge.repo}/pulls/${number}/comments`], opts).catch(() => "[]"),
    ]);
    return parseGitHubReviewDetail(prOut, inlineOut);
  }
  const [mrOut, notesOut] = await Promise.all([
    runCli(execFn, forge, ["mr", "view", String(number), "--output", "json"], opts),
    runCli(execFn, forge, ["api", `projects/:fullpath/merge_requests/${number}/discussions`], opts).catch(() => "[]"),
  ]);
  return parseGitLabReviewDetail(mrOut, notesOut);
}

export async function loadIssueDetail(execFn, forge, number, opts) {
  if (forge.kind === "github") {
    const out = await runCli(execFn, forge, ["issue", "view", String(number), "--json", `${GH_ISSUE_FIELDS},body`], opts);
    return parseGitHubIssueDetail(out);
  }
  const [itOut, notesOut] = await Promise.all([
    runCli(execFn, forge, ["issue", "view", String(number), "--output", "json"], opts),
    runCli(execFn, forge, ["api", `projects/:fullpath/issues/${number}/notes`], opts).catch(() => "[]"),
  ]);
  return parseGitLabIssueDetail(itOut, notesOut);
}

export async function postComment(execFn, forge, item, body, opts) {
  const text = String(body ?? "").trim();
  if (!text) throw new Error("Comment cannot be empty");
  const n = String(item.number);
  const args = forge.kind === "github"
    ? (item.kind === "review" ? ["pr", "comment", n, "--body", text] : ["issue", "comment", n, "--body", text])
    : (item.kind === "review" ? ["mr", "note", n, "--message", text] : ["issue", "note", n, "--message", text]);
  await runCli(execFn, forge, args, opts);
}
