// Tests the mod's git logic against real throwaway repositories (with a bare
// "remote"): parsing, what every button and menu item runs, and the history
// graph. Nothing here needs Herdr. Run: node tests/git.test.mjs
import * as G from "../mods/git-changes/git.js";
import { layoutLanes } from "../mods/git-changes/lanes.js";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const base = mkdtempSync(join(tmpdir(), "herdr-git-changes-"));
const run = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const runAll = (cwd, cmds) => { for (const c of cmds) run(cwd, c); };
const write = (cwd, file, text) => writeFileSync(join(cwd, file), text);
const append = (cwd, file, text) => appendFileSync(join(cwd, file), text);
const status = (cwd) => G.parseStatus(run(cwd, [...G.READ, ...G.STATUS]));
const entry = (cwd, path) => status(cwd).entries.find((e) => e.path === path);
const repo = (name, { remote } = {}) => {
  const dir = join(base, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env });
  if (remote) {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(base, `${name}.git`)], { env });
    run(dir, ["remote", "add", "origin", join(base, `${name}.git`)]);
  }
  return dir;
};
const commit = (cwd, msg, file = `${msg}.txt`) => { write(cwd, file, msg); run(cwd, ["add", "."]); run(cwd, ["commit", "-qm", msg]); };

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); process.exitCode = 1; }
};

// --- parsing -----------------------------------------------------------------

test("status: staged all / some / none, untracked, branch", () => {
  const r = repo("status");
  write(r, "a", "a\n"); write(r, "b", "b\n"); run(r, ["add", "."]); run(r, ["commit", "-qm", "init"]);
  append(r, "a", "a2\n"); append(r, "b", "b2\n"); run(r, ["add", "b"]); append(r, "b", "b3\n");
  write(r, "c", "c\n"); run(r, ["add", "c"]); write(r, "with space.txt", "n\n");
  const s = status(r);
  assert.equal(s.branch.head, "main");
  assert.ok(s.branch.oid);
  const by = Object.fromEntries(s.entries.map((e) => [e.path, e]));
  assert.equal(by.a.staged, "none"); assert.equal(by.a.status, "M");
  assert.equal(by.b.staged, "some");
  assert.equal(by.c.staged, "all"); assert.equal(by.c.status, "A");
  assert.equal(by["with space.txt"].untracked, true);
});

test("status: unborn branch and detached HEAD", () => {
  const r = repo("unborn");
  assert.equal(status(r).branch.oid, null);
  commit(r, "one"); commit(r, "two");
  run(r, ["switch", "-q", "--detach", "HEAD~1"]);
  const b = status(r).branch;
  assert.equal(b.detached, true); assert.equal(b.head, null);
});

test("status: merge conflict", () => {
  const r = repo("conflict");
  commit(r, "base", "f");
  run(r, ["switch", "-qc", "other"]); write(r, "f", "theirs\n"); run(r, ["commit", "-qam", "theirs"]);
  run(r, ["switch", "-q", "main"]); write(r, "f", "ours\n"); run(r, ["commit", "-qam", "ours"]);
  spawnSync("git", ["merge", "other"], { cwd: r, env });
  const e = entry(r, "f");
  assert.equal(e.conflict, true); assert.equal(e.status, "U");
  assert.equal(G.commitMode(status(r).entries), "conflict");
  assert.match(G.commitArgs({ message: "x", mode: "conflict" }).error, /conflict/i);
  runAll(r, G.toggleArgs(e, true));
  assert.equal(entry(r, "f").conflict, undefined);
});

test("numstat adds staged and unstaged counts", () => {
  const stats = G.parseNumstat("1\t0\ta\0", "2\t3\ta\0-\t-\tbin\0");
  assert.deepEqual(stats.a, { add: 3, del: 3, binary: false });
  assert.equal(stats.bin.binary, true);
});

test("diffRows numbers lines and keeps file headers when asked", () => {
  const lines = ["diff --git a/x b/x", "index 1..2", "--- a/x", "+++ b/x", "@@ -3,2 +3,3 @@", " keep", "-old", "+new", "+more"];
  const rows = G.diffRows(lines);
  assert.equal(rows[0].kind, "@");
  assert.deepEqual(rows.slice(1).map((r) => [r.kind, r.number]), [[" ", 3], ["-", 4], ["+", 4], ["+", 5]]);
  assert.equal(G.diffRows(lines, { headers: true })[0].kind, "f");
});

test("withContext shows the unchanged lines above and below each hunk, with both line numbers", () => {
  const file = Array.from({ length: 41 }, (_, i) => `l${i + 1}`);
  const diff = G.diffRows(["@@ -2,6 +2,7 @@", " l2", " l3", " l4", "+l5", " l6", " l7", " l8", "@@ -27,7 +28,7 @@", " l28", " l29", " l30", "-x", "+l31", " l32", " l33", " l34"]);
  const shownOf = (rows) => rows.map((r) => (r.expand ? `@${r.expand.up ? "↑" : ""}${r.expand.down ? "↓" : ""}` : r.kind === "@" ? "@" : r.number));
  const expand = (shown) => G.withContext(diff, new Map(Object.entries(shown)), new Map([["a.ts", file]]), "a.ts");
  const collapsed = expand({});
  assert.deepEqual(shownOf(collapsed).filter((s) => typeof s === "string"), ["@↑", "@↑↓", "@↓"], "the leading gap grows up, the middle both ways, the trailing gap down");
  assert.equal(collapsed.at(-1).text, "", "after the last hunk, an empty row holds the button");
  assert.deepEqual(collapsed[0].expand, { key: "a.ts:0", path: "a.ts", up: true, down: false });

  const opened = expand({ "a.ts:1": { up: 10, down: 10 }, "a.ts:2": { down: 5 } });
  const middle = opened.slice(opened.findIndex((r) => r.number === 8) + 1, opened.findIndex((r) => r.number === 28));
  assert.deepEqual(middle.map((r) => r.number), Array.from({ length: 19 }, (_, i) => i + 9), "a gap shown in full loses its header");
  assert.deepEqual(middle.map((r) => [r.kind, r.text]).slice(0, 2), [[" ", "l9"], [" ", "l10"]]);
  assert.deepEqual([middle[0].old, middle.at(-1).old], [8, 26], "old line numbers follow the line the first hunk added");
  assert.deepEqual(shownOf(opened).slice(-6), [35, 36, 37, 38, 39, "@↓"], "5 lines after the last hunk, then its button");

  const partly = expand({ "a.ts:0": { up: 10 } });
  assert.deepEqual(shownOf(partly).slice(0, 3), [1, 2, 3], "the leading gap holds one line: shown, its header goes");
  assert.deepEqual(shownOf(expand({ "a.ts:0": { up: 20 }, "a.ts:2": { down: 20 } })).slice(-2), [40, 41], "the trailing gap ends at the file's last line");
  assert.deepEqual(shownOf(G.withContext(diff, new Map([["a.ts:2", { down: 10 }]]), new Map(), "a.ts")).at(-1), "@↓", "without the file's text the buttons stay, and nothing is added");

  const added = G.diffRows(["diff --git a/n b/n", "@@ -0,0 +1,2 @@", "+a", "+b", "diff --git a/d b/d", "@@ -1,2 +0,0 @@", "-a", "-b"], { headers: true });
  assert.ok(G.withContext(added, new Map(), new Map()).every((r) => !r.expand), "an added or deleted file is shown whole, so it has no gaps");
});

test("image files get an image row in place of 'Binary file changed': modified, added, deleted, and an SVG with its text", () => {
  const r = repo("images");
  write(r, "keep.png", Buffer.from([137, 80, 78, 71, 1])); write(r, "gone.gif", Buffer.from("GIF89a\0\0\0\0")); write(r, "logo.svg", "<svg>\n</svg>\n"); write(r, "blob.bin", Buffer.from([0, 1, 2]));
  run(r, ["add", "."]); run(r, ["commit", "-qm", "init"]);
  write(r, "keep.png", Buffer.from([137, 80, 78, 71, 2, 3])); rmSync(join(r, "gone.gif")); write(r, "logo.svg", "<svg>\n<g/>\n</svg>\n");
  write(r, "blob.bin", Buffer.from([0, 9])); write(r, "fresh.webp", Buffer.from("RIFF")); run(r, ["add", "fresh.webp"]);
  const rows = G.diffRows(run(r, G.diffArgs({ area: "all" }, true)[0]).split("\n"), { headers: true });
  const images = rows.filter((x) => x.kind === "img");
  assert.deepEqual(images.map((x) => [x.path, x.type, x.change]), [["fresh.webp", "webp", "added"], ["gone.gif", "gif", "deleted"], ["keep.png", "png", "modified"], ["logo.svg", "svg", "modified"]]);
  const at = (path) => rows.findIndex((x) => x.kind === "img" && x.path === path);
  assert.equal(rows[at("keep.png") - 1].text, "keep.png", "the image row follows its file header");
  assert.equal(rows.filter((x) => x.text === "Binary file changed").length, 1, "only the non-image binary keeps the plain row");
  assert.ok(rows[at("logo.svg") + 1].kind === "@", "an SVG's text diff still follows its picture");
  assert.ok(G.diffRows(run(r, G.diffArgs({ area: "file", path: "keep.png" }, true)[0]).split("\n")).some((x) => x.kind === "img"), "a single file's diff keeps its image row without a header");
});

test("where each side of an image comes from, by what is being shown", () => {
  const row = (change) => ({ path: "a/b.png", change });
  assert.deepEqual(G.fileSides({ area: "file" }, row("modified"), true), { before: { revs: ["HEAD:a/b.png"] }, after: { worktree: "a/b.png" } });
  assert.deepEqual(G.fileSides({ area: "file" }, row("added"), true), { before: null, after: { worktree: "a/b.png" } });
  assert.deepEqual(G.fileSides({ area: "file" }, row("deleted"), true), { before: { revs: ["HEAD:a/b.png"] }, after: null });
  assert.equal(G.fileSides({ area: "all" }, row("modified"), false).before, null, "no commit yet: nothing before");
  assert.deepEqual(G.fileSides({ area: "commit", hash: "abc" }, row("modified"), true), { before: { revs: ["abc^1:a/b.png"] }, after: { revs: ["abc:a/b.png"] } });
  assert.deepEqual(G.fileSides({ area: "stash", ref: "stash@{0}" }, row("added"), true), { before: null, after: { revs: ["stash@{0}:a/b.png", "stash@{0}^3:a/b.png"] } });
});

test("image types: the usual ones, in any case, and nothing else", () => {
  for (const path of ["a.png", "a.PNG", "x/y.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.bmp"]) assert.ok(G.imageType(path), path);
  for (const path of ["a.txt", "png", "a.png.bak", "a.psd", "dir.png/readme"]) assert.equal(G.imageType(path), null, path);
});

test("markdown files: .md and .markdown, in any case, and nothing else", () => {
  for (const path of ["README.md", "docs/a.MD", "a.markdown"]) assert.ok(G.isMarkdown(path), path);
  for (const path of ["a.txt", "md", "a.md.bak", "a.mdx", "dir.md/readme"]) assert.equal(G.isMarkdown(path), false, path);
});

test("the file tree knows how much of each folder is staged", () => {
  const e = (path, staged) => ({ path, staged });
  const rows = G.fileTree([e("a/b/x", "all"), e("a/b/y", "all"), e("a/z", "none"), e("top", "some")]);
  const by = Object.fromEntries(rows.filter((r) => r.kind === "folder").map((r) => [r.path, r]));
  assert.equal(by["a/b"].staged, "all"); assert.equal(by["a/b"].files, 2);
  assert.equal(by.a.staged, "some"); assert.equal(by.a.files, 3);
  assert.equal(G.fileTree([e("a/b/x", "none")])[0].staged, "none");
});

test("suggested message for one file", () => {
  assert.equal(G.suggestMessage([{ path: "src/y.ts", status: "M" }]), "Update y.ts");
  assert.equal(G.suggestMessage([{ path: "n.md", status: "A" }]), "Create n.md");
  assert.equal(G.suggestMessage([{ path: "a", status: "M" }, { path: "b", status: "M" }]), "");
});

// --- buttons -------------------------------------------------------------------

test("checkbox stages and unstages a file, before and after the first commit", () => {
  const r = repo("toggle");
  write(r, "f", "1\n");
  runAll(r, G.toggleArgs(entry(r, "f"), false));
  assert.equal(entry(r, "f").staged, "all");
  runAll(r, G.toggleArgs(entry(r, "f"), false));
  assert.equal(entry(r, "f").untracked, true);
  run(r, ["add", "f"]); run(r, ["commit", "-qm", "one"]);
  append(r, "f", "2\n");
  runAll(r, G.toggleArgs(entry(r, "f"), true));
  assert.equal(entry(r, "f").staged, "all");
  runAll(r, G.toggleArgs(entry(r, "f"), true));
  assert.equal(entry(r, "f").staged, "none");
});

test("Commit commits what's staged; Commit Tracked is commit -a", () => {
  const r = repo("commit");
  commit(r, "init", "a"); commit(r, "init2", "b");
  append(r, "a", "x\n"); append(r, "b", "y\n"); run(r, ["add", "a"]); write(r, "new", "n\n");
  assert.equal(G.commitMode(status(r).entries), "staged");
  runAll(r, G.commitArgs({ message: "staged only", mode: "staged" }).cmds);
  assert.deepEqual(status(r).entries.map((e) => e.path).sort(), ["b", "new"]);
  assert.equal(G.commitMode(status(r).entries), "tracked");
  runAll(r, G.commitArgs({ message: "tracked", mode: "tracked", signoff: true }).cmds);
  assert.deepEqual(status(r).entries.map((e) => e.path), ["new"]);
  assert.match(run(r, ["log", "-1", "--format=%B"]), /Signed-off-by: T <t@t>/);
  assert.equal(G.commitMode(status(r).entries), "none");
  assert.ok(G.commitArgs({ message: "x", mode: "none" }).error);
  assert.ok(G.commitArgs({ message: " ", mode: "staged" }).error);
});

test("Amend with no message keeps the last one", () => {
  const r = repo("amend");
  commit(r, "first message");
  append(r, "first message.txt", "more\n"); run(r, ["add", "."]);
  runAll(r, G.commitArgs({ message: "", amend: true, mode: "staged" }).cmds);
  assert.equal(run(r, ["log", "--format=%s"]).trim(), "first message");
  assert.equal(status(r).entries.length, 0);
});

test("Discard returns a file to HEAD; a new or untracked file is removed", () => {
  const r = repo("discard");
  commit(r, "init", "a");
  append(r, "a", "x\n"); run(r, ["add", "a"]); append(r, "a", "y\n");
  write(r, "staged-new", "s\n"); run(r, ["add", "staged-new"]); write(r, "untracked", "u\n");
  for (const e of status(r).entries) runAll(r, G.discardArgs(e, true));
  assert.equal(status(r).entries.length, 0);
  assert.equal(existsSync(join(r, "staged-new")), false);
  assert.equal(existsSync(join(r, "untracked")), false);
});

test("Stash all (untracked too), stash staged only, apply, pop, drop", () => {
  const r = repo("stash");
  commit(r, "init", "a"); commit(r, "init2", "b");
  append(r, "a", "x\n"); write(r, "new", "n\n");
  runAll(r, G.stashPushArgs("wip"));
  assert.equal(status(r).entries.length, 0);
  let list = G.parseStashes(run(r, G.STASHES));
  assert.equal(list[0].subject, "wip");
  const rows = G.diffRows(run(r, G.diffArgs({ ...list[0], area: "stash" }, true)[0]).split("\n"), { headers: true });
  assert.ok(rows.some((x) => x.kind === "f" && x.text === "new"), "the stash diff shows the untracked file");
  runAll(r, G.stashArgs("apply", list[0].ref));
  assert.equal(status(r).entries.length, 2);
  assert.equal(G.parseStashes(run(r, G.STASHES)).length, 1);
  runAll(r, G.discardTrackedArgs(true)); runAll(r, G.trashUntrackedArgs());
  runAll(r, G.stashArgs("pop", "stash@{0}"));
  assert.equal(G.parseStashes(run(r, G.STASHES)).length, 0);
  run(r, ["add", "a"]); append(r, "b", "y\n");
  runAll(r, G.stashPushArgs("", { staged: true }));
  assert.deepEqual(status(r).entries.map((e) => e.path).sort(), ["b", "new"]);
  runAll(r, G.stashArgs("drop", "stash@{0}"));
  assert.equal(G.parseStashes(run(r, G.STASHES)).length, 0);
});

test("Uncommit keeps the changes staged, also for the root commit", () => {
  const r = repo("uncommit");
  commit(r, "one"); commit(r, "two");
  runAll(r, G.uncommitArgs(true));
  assert.equal(run(r, ["log", "--format=%s"]).trim(), "one");
  assert.equal(entry(r, "two.txt").staged, "all");
  runAll(r, G.uncommitArgs(false));
  assert.equal(status(r).branch.oid, null);
  assert.equal(entry(r, "one.txt").staged, "all");
});

test("Remote button: Publish, Push ↑N, Pull ↓N, else Fetch", () => {
  const r = repo("remote", { remote: true });
  commit(r, "one");
  assert.equal(G.remoteAction(status(r).branch, [], true), null);
  assert.equal(G.remoteAction(status(r).branch, ["origin"], true).label, "Publish");
  const p = G.pushArgs(status(r).branch, ["origin"]);
  assert.equal(p.remote, "origin");
  runAll(r, p.cmds);
  assert.equal(status(r).branch.upstream, "origin/main");
  assert.equal(G.remoteAction(status(r).branch, ["origin"], true).label, "Fetch");
  commit(r, "two");
  assert.equal(G.remoteAction(status(r).branch, ["origin"], true).count, "↑1");
  runAll(r, G.pushArgs(status(r).branch, ["origin"]).cmds);
  // Another clone pushes; this one falls behind.
  const other = join(base, "remote-other");
  execFileSync("git", ["clone", "-q", join(base, "remote.git"), other], { env });
  commit(other, "three"); run(other, ["push", "-q"]);
  runAll(r, G.fetchArgs());
  const behind = G.remoteAction(status(r).branch, ["origin"], true);
  assert.equal(behind.type, "pull"); assert.equal(behind.count, "↓1");
  runAll(r, G.pullArgs(status(r).branch).cmds);
  assert.equal(status(r).branch.behind, 0);
  assert.ok(G.pushArgs({ detached: true }, ["origin"]).error);
  assert.ok(G.pullArgs({ upstream: null }).error);
});

test("Force push with lease replaces an amended pushed commit", () => {
  const r = repo("force", { remote: true });
  commit(r, "one"); runAll(r, G.pushArgs(status(r).branch, ["origin"]).cmds);
  runAll(r, G.commitArgs({ message: "one, amended", amend: true, mode: "none" }).cmds);
  assert.throws(() => runAll(r, G.pushArgs(status(r).branch, ["origin"]).cmds));
  runAll(r, G.pushArgs(status(r).branch, ["origin"], { force: true }).cmds);
  assert.equal(status(r).branch.ahead, 0);
});

test("Checkout a branch, a remote branch (tracking) and a commit", () => {
  const r = repo("checkout", { remote: true });
  commit(r, "one"); run(r, ["branch", "feat"]);
  run(r, ["push", "-q", "origin", "main", "feat:remote-only"]); run(r, ["fetch", "-q"]);
  runAll(r, G.checkoutArgs("feat"));
  assert.equal(status(r).branch.head, "feat");
  runAll(r, G.checkoutRemoteArgs("origin/remote-only"));
  assert.equal(status(r).branch.upstream, "origin/remote-only");
  runAll(r, G.detachArgs(run(r, ["rev-parse", "HEAD"]).trim()));
  assert.equal(status(r).branch.detached, true);
});

// --- history -------------------------------------------------------------------

test("History: lanes for a merge and an open branch, labels, the dashed row", () => {
  const r = repo("history", { remote: true });
  commit(r, "a"); commit(r, "b");
  run(r, ["switch", "-qc", "feat"]); commit(r, "f1");
  run(r, ["switch", "-q", "main"]); commit(r, "c");
  run(r, ["merge", "-q", "--no-ff", "--no-edit", "feat"]); run(r, ["tag", "v1"]);
  run(r, ["switch", "-qc", "side", "HEAD~1"]); commit(r, "side");
  run(r, ["switch", "-q", "main"]);
  runAll(r, G.pushArgs(status(r).branch, ["origin"]).cmds);
  run(r, ["push", "-q", "origin", "side:only-remote"]); run(r, ["fetch", "-q"]);
  append(r, "a.txt", "dirty\n");
  const head = run(r, ["rev-parse", "HEAD"]).trim();
  const log = G.parseLog(run(r, G.historyArgs({ all: true, limit: 50 })));
  const commits = G.withUncommitted(log, 1, head);
  const { rows, width } = layoutLanes(commits);
  assert.equal(commits[0].uncommitted, true);
  assert.equal(rows[0].segments.at(-1)[5], true, "uncommitted joins HEAD dashed");
  assert.ok(width >= 2, `a merge needs more than one lane, got ${width}`);
  const merge = log.find((c) => c.parents.length === 2);
  assert.ok(merge.head);
  const labels = G.labelsOf(merge).map((l) => `${l.kind}:${l.text}`);
  assert.equal(labels[0], "branch:main", "the checked-out branch comes first");
  assert.ok(labels.includes("tag:v1"));
  assert.ok(G.labelsOf(merge)[0].synced, "main carries origin/main");
  const remoteOnly = log.find((c) => c.refs.some((x) => x.name === "origin/only-remote"));
  assert.ok(G.labelsOf(remoteOnly).some((l) => l.text === "origin/only-remote"));
  assert.equal(G.labelsOf(remoteOnly, () => false).some((l) => l.kind === "remote"), false);
});

test("History without remotes keeps the upstream and drops other remote lanes", () => {
  const r = join(base, "history");
  // A remote branch that forks off with commits no local branch reaches: its own lane when remotes show.
  run(r, ["switch", "-qc", "tmp", "HEAD~2"]); commit(r, "remote work");
  run(r, ["push", "-q", "origin", "tmp:far-away"]); run(r, ["fetch", "-q"]);
  run(r, ["switch", "-q", "main"]); run(r, ["branch", "-D", "tmp"]);
  const all = G.parseLog(run(r, G.historyArgs({ all: true, remotes: true, limit: 50 })));
  const own = G.parseLog(run(r, G.historyArgs({ all: true, remotes: false, upstream: "origin/main", limit: 50 })));
  assert.ok(all.some((c) => c.subject === "remote work"));
  assert.equal(own.some((c) => c.subject === "remote work"), false, "a remote-only commit is left out");
  assert.ok(layoutLanes(own).width < layoutLanes(all).width, `fewer lanes without remotes (${layoutLanes(own).width} vs ${layoutLanes(all).width})`);
  assert.ok(own.some((c) => c.refs.some((x) => x.name === "origin/main")), "the upstream still shows");
  // A remote ref on a commit a local branch reaches gets no label of its own.
  const side = own.find((c) => c.refs.some((x) => x.name === "origin/only-remote"));
  assert.equal(G.labelsOf(side, (n) => n === "origin/main").some((l) => l.kind === "remote"), false);
  const current = G.parseLog(run(r, G.historyArgs({ all: false, limit: 50 })));
  assert.equal(current.some((c) => c.subject === "side"), false);
});

test("Revert and the commit's own diff", () => {
  const r = repo("revert");
  commit(r, "one"); commit(r, "two");
  const two = G.parseLog(run(r, G.historyArgs({ all: false, limit: 1 })))[0];
  const rows = G.diffRows(run(r, G.diffArgs({ ...two, area: "commit" }, true)[0]).split("\n"), { headers: true });
  assert.ok(rows.some((x) => x.kind === "+" && x.text === "two"));
  runAll(r, G.revertArgs(two.hash));
  assert.match(run(r, ["log", "-1", "--format=%s"]), /Revert "two"/);
  assert.equal(existsSync(join(r, "two.txt")), false);
});

test("A commit's message splits into its subject, body and footer", () => {
  const r = repo("message");
  const message = (msg) => { run(r, ["commit", "-q", "--allow-empty", "-m", msg]); return G.parseCommitMessage(run(r, [...G.READ, ...G.commitMessageArgs("HEAD")])); };
  const full = message("feat(x): add y\n\nWhy it matters,\nover two lines.\n\nAnd a second paragraph.\n\nBREAKING CHANGE: y replaces z\n  for everyone\nFixes #5\nCo-Authored-By: A <a@b>");
  assert.equal(full.subject, "feat(x): add y");
  assert.equal(full.body, "Why it matters,\nover two lines.\n\nAnd a second paragraph.");
  assert.equal(full.footer, "BREAKING CHANGE: y replaces z\n  for everyone\nFixes #5\nCo-Authored-By: A <a@b>");
  assert.equal(full.hash, run(r, ["rev-parse", "HEAD"]).trim());
  assert.equal(full.author, "T");
  assert.ok(full.short.length >= 7 && full.hash.startsWith(full.short) && full.time > 0);
  const one = message("fix: one line");
  assert.deepEqual([one.subject, one.body, one.footer], ["fix: one line", "", ""]);
  const prose = message("chore: tidy\n\nNote: this is prose,\nnot a footer.");
  assert.equal(prose.body, "Note: this is prose,\nnot a footer.");
  assert.equal(prose.footer, "", "a last paragraph with other lines is body");
  const onlyFooter = message("docs: x\n\nSigned-off-by: T <t@t>");
  assert.deepEqual([onlyFooter.body, onlyFooter.footer], ["", "Signed-off-by: T <t@t>"]);
  assert.deepEqual(G.parseTrailer("Refs #12"), { key: "Refs", separator: " #", value: "12" });
  assert.equal(G.parseTrailer("not a trailer"), null);
});

// --- the Repo tab: what the branch changed since its base ----------------------------

const currentOf = (cwd) => run(cwd, ["branch", "--show-current"]).trim() || null;
const baseOf = (cwd) => G.nearestBase(G.parseBaseRefs(run(cwd, [...G.READ, ...G.baseRefsArgs(true)])), currentOf(cwd));
const baseCountedOneByOne = (cwd) => G.nearestBase(G.parseBaseRefs(run(cwd, [...G.READ, ...G.baseRefsArgs(false)]))
  .map((b) => { const [ahead, behind] = G.parseAheadBehind(run(cwd, [...G.READ, ...G.aheadBehindArgs(b.ref)])); return { ...b, ahead, behind }; }), currentOf(cwd));

test("the base is the nearest main, master, develop or release branch, as a merge request's target", () => {
  const r = repo("base-release", { remote: true });
  commit(r, "init"); commit(r, "main moves on");
  run(r, ["switch", "-qc", "release/1.x", "HEAD~1"]); commit(r, "release 1 fix");
  run(r, ["switch", "-qc", "release/2.x", "main"]); commit(r, "release 2 work");
  run(r, ["push", "-q", "origin", "main", "release/1.x", "release/2.x"]); run(r, ["fetch", "-q"]);
  run(r, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release/2.x"]);
  run(r, ["switch", "-qc", "feature", "origin/release/1.x"]); commit(r, "feature one"); commit(r, "feature two");
  assert.equal(baseOf(r), "origin/release/1.x", "the release it started from, not main or the default branch; remote before local");
  assert.equal(baseCountedOneByOne(r), "origin/release/1.x", "the same before git 2.41");
  run(r, ["push", "-q", "origin", "--delete", "release/1.x"]); run(r, ["fetch", "-q", "--prune"]);
  assert.equal(baseOf(r), "release/1.x", "a local branch counts too");
  run(r, ["switch", "-q", "main"]); commit(r, "unpushed");
  assert.equal(baseOf(r), "origin/main", "on main, the base is its upstream, never itself");
});

test("origin's default branch counts whatever its name, and without any base there is none", () => {
  const r = repo("base-trunk", { remote: true });
  run(r, ["branch", "-m", "trunk"]); commit(r, "init");
  assert.equal(baseOf(r), null, "no main, master, develop or release");
  run(r, ["push", "-q", "origin", "trunk"]); run(r, ["fetch", "-q"]);
  run(r, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
  run(r, ["switch", "-qc", "feature"]); commit(r, "work");
  assert.equal(baseOf(r), "origin/trunk");
});

test("a branch's files since its base: only what its commits changed, with their line counts", () => {
  const r = repo("branch-files");
  commit(r, "init", "kept.txt"); write(r, "gone.txt", "g\n"); write(r, "edited.txt", "a\n"); run(r, ["add", "."]); run(r, ["commit", "-qm", "more"]);
  commit(r, "on main later", "main-only.txt");
  run(r, ["switch", "-qc", "feature", "HEAD~1"]);
  mkdirSync(join(r, "src")); commit(r, "feature work", "src/new.txt");
  run(r, ["rm", "-q", "gone.txt"]); run(r, ["commit", "-qm", "drop gone"]);
  append(r, "edited.txt", "b\nc\n"); run(r, ["commit", "-qam", "edit"]);
  append(r, "edited.txt", "uncommitted\n");
  write(r, "staged.txt", "s\n"); run(r, ["add", "staged.txt"]);
  write(r, "loose.txt", "l\n");
  const base = baseOf(r), mergeBase = run(r, G.mergeBaseArgs(base)).trim(), head = run(r, ["rev-parse", "HEAD"]).trim();
  const entries = G.branchEntries(run(r, G.baseNameStatusArgs(mergeBase, head)), run(r, G.baseNumstatArgs(mergeBase, head)));
  assert.deepEqual(entries.map((e) => [e.path, e.status, e.add, e.del]), [
    ["edited.txt", "M", 2, 0], ["gone.txt", "D", 0, 1], ["src/new.txt", "A", 1, 0],
  ], "no staged, unstaged or untracked work, and not main's own later work");
  const rows = G.diffRows(run(r, G.diffArgs({ area: "base-file", base: mergeBase, head, path: "edited.txt" }, true)[0]).split("\n"));
  assert.deepEqual(rows.filter((x) => x.kind === "+").map((x) => x.text), ["b", "c"]);
  const all = run(r, G.diffArgs({ area: "base", base: mergeBase, head }, true)[0]);
  assert.ok(all.includes("b/src/new.txt") && all.includes("b/gone.txt") && !all.includes("main-only") && !all.includes("staged.txt"));
});

test("a branch's moved files: one entry each, diffed against where they were", () => {
  const r = repo("branch-moves");
  const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
  write(r, "old.spec.ts", body); write(r, "same.txt", body.toUpperCase()); run(r, ["add", "."]); run(r, ["commit", "-qm", "init"]);
  run(r, ["switch", "-qc", "feature"]);
  run(r, ["mv", "old.spec.ts", "new.spec.ts"]); mkdirSync(join(r, "moved")); run(r, ["mv", "same.txt", "moved/same.txt"]);
  write(r, "new.spec.ts", body.replace("line 3\n", "line three\n")); run(r, ["commit", "-qam", "move"]);
  const base = baseOf(r), mergeBase = run(r, G.mergeBaseArgs(base)).trim(), head = run(r, ["rev-parse", "HEAD"]).trim();
  const entries = G.branchEntries(run(r, G.baseNameStatusArgs(mergeBase, head)), run(r, G.baseNumstatArgs(mergeBase, head)));
  assert.deepEqual(entries.map((e) => [e.path, e.from, e.status, e.add, e.del]), [
    ["moved/same.txt", "same.txt", "R", 0, 0], ["new.spec.ts", "old.spec.ts", "R", 1, 1],
  ]);
  const rowsOf = (e) => G.diffRows(run(r, G.diffArgs({ area: "base-file", base: mergeBase, head, ...e }, true)[0]).split("\n"));
  const edited = rowsOf(entries[1]);
  assert.deepEqual(edited.filter((x) => x.kind === "-" || x.kind === "+").map((x) => x.kind + x.text), ["-line 3", "+line three"]);
  assert.ok(edited.some((x) => x.text === "Moved from old.spec.ts"));
  assert.deepEqual(rowsOf(entries[0]).map((x) => x.text), ["Moved from same.txt"]);
  const all = G.diffRows(run(r, G.diffArgs({ area: "base", base: mergeBase, head }, true)[0]).split("\n"));
  assert.deepEqual(all.filter((x) => x.kind === "f" || x.kind === "").map((x) => x.text),
    ["moved/same.txt", "Moved from same.txt", "new.spec.ts", "Moved from old.spec.ts"]);
});

test("an image's old side comes from where it was before a move", () => {
  const rows = G.diffRows(["diff --git a/old.png b/new.png", "similarity index 90%", "rename from old.png", "rename to new.png", "Binary files a/old.png and b/new.png differ"]);
  const image = rows.find((x) => x.kind === "img");
  assert.equal(image.from, "old.png");
  assert.deepEqual(G.fileSides({ area: "base-file", base: "b1", head: "h1" }, image, true), { before: { revs: ["b1:old.png"] }, after: { revs: ["h1:new.png"] } });
});

rmSync(base, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
