// Tests the GitHub/GitLab forge adapter: remote detection, CLI arguments,
// CI pipeline status normalization, and PR/MR + Issue list and detail parsers.
// Nothing here needs Herdr, git or network. Run: node tests/forge.test.mjs
import * as F from "../mods/git-changes/forge.js";
import assert from "node:assert/strict";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); process.exitCode = 1; }
};

test("parseRemote recognizes GitHub and GitLab (cloud and self-hosted) SSH and HTTPS URLs", () => {
  assert.deepEqual(F.parseRemote("git@github.com:daniell0gda/herdr-git-changes.git"), {
    kind: "github", host: "github.com", repo: "daniell0gda/herdr-git-changes", cli: "gh", label: "PRs", singular: "PR",
  });
  assert.deepEqual(F.parseRemote("https://github.com/org/repo"), {
    kind: "github", host: "github.com", repo: "org/repo", cli: "gh", label: "PRs", singular: "PR",
  });
  assert.deepEqual(F.parseRemote("git@gitlab.company.internal:team/sub/service.git"), {
    kind: "gitlab", host: "gitlab.company.internal", repo: "team/sub/service", cli: "glab", label: "MRs", singular: "MR",
  });
  assert.equal(F.parseRemote("/tmp/local-bare-repo.git"), null);
  assert.equal(F.parseRemote("https://bitbucket.org/org/repo.git"), null);
});

test("detectForgeFromRemotes prefers origin over other remotes", () => {
  const out = [
    "upstream\thttps://gitlab.com/other/repo.git (fetch)",
    "origin\tgit@github.com:me/repo.git (fetch)",
  ].join("\n");
  assert.equal(F.detectForgeFromRemotes(out)?.kind, "github");
  assert.equal(F.detectForgeFromRemotes("local\t/tmp/bare.git (fetch)"), null);
});

test("CI status summarizes pass, fail, running and empty runs for GitHub and GitLab", () => {
  const ghPass = F.parseGitHubRuns(JSON.stringify([
    { workflowName: "CI", status: "completed", conclusion: "success", url: "https://gh/1" },
    { workflowName: "Lint", status: "completed", conclusion: "success", url: "https://gh/2" },
  ]));
  assert.equal(ghPass.state, "pass");
  assert.equal(ghPass.summary, "2/2 passed");

  const ghFail = F.parseGitHubRuns(JSON.stringify([
    { workflowName: "CI", status: "completed", conclusion: "failure", url: "https://gh/1" },
    { workflowName: "Lint", status: "completed", conclusion: "success", url: "https://gh/2" },
  ]));
  assert.equal(ghFail.state, "fail");
  assert.ok(ghFail.summary.includes("1 failed"));

  const glRun = F.parseGitLabPipeline(
    JSON.stringify([{ id: 42, status: "running", web_url: "https://gl/42" }]),
    JSON.stringify([{ id: 101, name: "test", status: "running", web_url: "https://gl/j1" }, { id: 102, name: "build", status: "success", web_url: "https://gl/j2" }]),
  );
  assert.equal(glRun.state, "running");
  assert.equal(glRun.jobs.length, 2);
  assert.equal(F.parseGitHubRuns("[]").state, "none");

  const ghChecks = F.parseGitHubCheckRuns(JSON.stringify({
    check_runs: [{ id: 55, name: "unit-tests", status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/999/job/55" }],
  }));
  assert.equal(ghChecks.state, "fail");
  assert.equal(ghChecks.jobs[0].runId, "999");
  assert.equal(ghChecks.jobs[0].name, "unit-tests");
  assert.equal(F.parseGitHubRuns(JSON.stringify([{ displayTitle: "(Unknown event)", status: "completed", conclusion: "failure" }])).state, "none");
});

test("GitHub PR list and detail normalize assignees, reviewers, checks, inline comments and files", () => {
  const list = F.parseGitHubReviews(JSON.stringify([{
    number: 12, title: "Add forge tab", state: "OPEN", isDraft: false,
    author: { login: "alice" }, assignees: [{ login: "bob" }],
    reviewRequests: [{ login: "carol" }], headRefName: "feat/forge", baseRefName: "main",
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    comments: [{ body: "hi" }], url: "https://gh/pr/12",
  }]));
  assert.equal(list[0].number, 12);
  assert.equal(list[0].ciState, "pass");
  assert.deepEqual(list[0].assignees, ["bob"]);
  assert.deepEqual(list[0].reviewers, ["carol"]);

  const detail = F.parseGitHubReviewDetail(JSON.stringify({
    number: 12, title: "Add forge tab", body: "Details here", state: "OPEN",
    author: { login: "alice" }, assignees: [{ login: "bob" }],
    reviewRequests: [{ login: "carol" }],
    reviews: [{ author: { login: "dave" }, state: "APPROVED" }],
    labels: [{ name: "enhancement" }],
    comments: [{ author: { login: "bob" }, body: "Looks good", createdAt: "2026-01-01T10:00:00Z" }],
    files: [{ path: "mods/forge.js", additions: 50, deletions: 2 }],
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
  }), JSON.stringify([
    { user: { login: "carol" }, body: "Nit: rename", path: "mods/forge.js", line: 14, created_at: "2026-01-01T11:00:00Z" },
  ]));
  assert.equal(detail.comments.length, 2);
  assert.equal(detail.comments[1].path, "mods/forge.js");
  assert.equal(detail.comments[1].line, 14);
  assert.deepEqual(detail.reviewers, [{ login: "carol", state: "requested" }, { login: "dave", state: "approved" }]);
  assert.equal(detail.files[0].additions, 50);
});

test("GitLab MR and Issue parsers normalize into the same shape", () => {
  const mrs = F.parseGitLabReviews(JSON.stringify([{
    iid: 7, title: "Fix CI", state: "opened", draft: true,
    author: { username: "maciej" }, assignees: [{ username: "anna" }], reviewers: [{ username: "piotr" }],
    source_branch: "fix/ci", target_branch: "main", head_pipeline: { status: "failed" }, user_notes_count: 3,
  }]));
  assert.equal(mrs[0].number, 7);
  assert.equal(mrs[0].state, "draft");
  assert.equal(mrs[0].ciState, "fail");
  assert.deepEqual(mrs[0].reviewers, ["piotr"]);

  const mrDetail = F.parseGitLabReviewDetail(
    JSON.stringify({ iid: 7, title: "Fix CI", description: "Body", author: { username: "maciej" }, head_pipeline: { id: 9, status: "success" } }),
    JSON.stringify([{ notes: [{ system: true, body: "assigned" }, { system: false, author: { username: "piotr" }, body: "Please squash", position: { new_path: "a.js", new_line: 9 } }] }]),
  );
  assert.equal(mrDetail.comments.length, 1);
  assert.equal(mrDetail.comments[0].path, "a.js");
  assert.equal(mrDetail.comments[0].line, 9);

  const issues = F.parseGitHubIssues(JSON.stringify([{ number: 5, title: "Add issues", state: "OPEN", author: { login: "maciej" }, assignees: [], labels: [{ name: "feat" }], comments: [] }]));
  assert.equal(issues[0].kind, "issue");
  assert.deepEqual(issues[0].labels, ["feat"]);
});

console.log(`${passed} passed`);
