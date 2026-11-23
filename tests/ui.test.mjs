// Runs the panel and the diff tab under node with a stand-in for Herdr and
// GPUI, against a real throwaway repository: every render path is exercised,
// including virtual-list rows, which `herdr-app check` never draws.
// Run: node tests/ui.test.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { png, svgText } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url)), modDir = join(here, "../mods/git-changes");
// realpathSync: on macOS the temp folder is a symlink, and git reports the real path.
const base = realpathSync(mkdtempSync(join(tmpdir(), "herdr-git-changes-ui-")));

// --- the stand-in -------------------------------------------------------------

// Copy the mod with its three runtime imports pointed at one stub module.
const lib = join(base, "mod");
mkdirSync(lib);
for (const f of readdirSync(modDir).filter((f) => f.endsWith(".js")))
  writeFileSync(join(lib, f), readFileSync(join(modDir, f), "utf8").replace(/from "(gpui-kit|gpui-base|herdr)"/g, 'from "./_stub.js"').replace(/from "fs\/promises"/g, 'from "./_fs.js"'));
writeFileSync(join(lib, "_fs.js"), `
import * as fs from "node:fs/promises";
export const exists = (p) => fs.access(p).then(() => true, () => false);
export const { mkdir, readFile, readdir, unlink, writeFile } = fs;
`);
writeFileSync(join(lib, "_stub.js"), `
const H = globalThis.__herdr;
// Every element is a node that records its children, text and handlers; any builder call chains.
// Like Herdr, it refuses a handler registered while a virtual list's renderer runs.
function el(kind) {
  const node = { kind, kids: [], items: null, handlers: {}, props: {} };
  const proxy = new Proxy(node, { get(t, k) {
    if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
    if (k === "then") return undefined;
    H.calls++;
    if (k === "child") return (c) => { t.kids.push(c); return proxy; };
    if (k === "children") return (cs) => { t.kids.push(...cs); return proxy; };
    if (k === "when") return (b, f) => (b ? f(proxy) ?? proxy : proxy);
    return (...a) => {
      if (k === "id") t.id = a[0];
      if (k.startsWith("on_") && H.rendering) throw new Error("a handler (" + k + ") inside a virtual list renderer");
      if (k.startsWith("on_")) t.handlers[k.slice(3) + (typeof a[0] === "string" && a.length > 1 ? ":" + a[0] : "")] = a.at(-1);
      if (k === "hover") { t.hoverStyle = el("hover"); a[0](t.hoverStyle); }
      t.props[k] = a;
      return proxy;
    };
  } });
  return proxy;
}
export class View {}
export const div = () => el("div"), svg = (p) => { const e = el("svg"); e.props.path = [p]; return e; };
export const image = (p) => { const e = el("image"); e.props.path = [p]; return e; };
export const TextView = { markdown: (id, text) => { const e = el("markdown"); e.id = id; e.props.markdown = [text]; return e; } };
export const v_flex = () => el("v"), h_flex = () => el("h");
export const PathBuilder = { stroke: () => { const b = { move_to: () => b, line_to: () => b, cubic_bezier_to: () => b, dash_array: () => b, build: () => ({}) }; return b; } };
globalThis.window = { paint_path: () => el("path") };
// A virtual list draws every row at once here (or the first H.visibleRows), so every row's code runs.
export function v_virtual_list(id, count, sizes, key, render) {
  const e = el("list"); e.id = id; e.sizes = sizes;
  H.rendering = true;
  try { e.items = render({ start: 0, end: Math.min(count, H.visibleRows) }, H.cx()); } finally { H.rendering = false; }
  e.keys = Array.from({ length: count }, (_, i) => key(i));
  return e;
}
export const Scrollbar = { vertical: () => el("bar") };
export const VirtualListScrollHandle = { new: () => ({ scroll_to_item(i) { H.scrolledTo = i; }, scroll_to_bottom() {}, release: () => true }) };
const state = () => ({ v: "", handlers: {}, value() { return this.v; }, set_value(v) { this.v = v; }, on(event, fn) { this.handlers[event] = fn; }, focus() { this.focused = true; }, set_auto_grow() {}, set_selected_range() {} });
export const InputState = { new: state }, TextareaState = { new: state };
export const Input = { new: () => el("input") }, Textarea = { new: () => el("textarea") };
export const spaces = () => { H.hostCalls++; return H.spaces; }, panes = () => H.panes, focused = () => H.focused, layout = () => ({});
export const window = () => ({ platform: H.platform });
export const appHome = () => H.appHome;
export const home = () => H.home;
export const theme = () => new Proxy({}, { get: (_t, k) => "#" + String(k).padEnd(6, "0").slice(0, 6) });
export const settings = () => ({ zoom: 1, font_family: "Mono" });
export const props = () => H.props();
export const shared = (k) => { H.hostCalls++; return H.shared[k]; };
export const setShared = (k, v) => { H.shared[k] = v; return null; };
export const run = (name, args) => { H.runs.push([name, args]); return null; };
export const notify = (n) => { H.notes.push(n); return ""; };
export const openOverlay = (spec) => { H.overlays.push(spec); return "o1"; };
export const closeOverlay = () => null;
export const exec = (cmd, args, opts) => H.exec(cmd, args, opts);
export const hc = (args) => H.hc(args);
export const knownAgents = (opts) => (H.knownAgents ? H.knownAgents(opts) : Promise.resolve([]));
export const terminals = () => H.terminals;
export const readTextFile = (p) => H.read(p);
export const writeTextFile = (p, text, expected) => H.write(p, text, expected);
export const watchFolder = () => new Promise(() => {});
export const nextCommand = () => new Promise(() => {});
`);

globalThis.localStorage = { m: {}, getItem(k) { return this.m[k] ?? null; }, setItem(k, v) { this.m[k] = String(v); } };
const claudeHome = join(base, "claude-home");
const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CLAUDE_CONFIG_DIR: claudeHome };
const tasks = [];
const OPENERS = ["xdg-open", "open", "explorer"];
const GIO = {
  info: "uri: file:///x\nattributes:\n  standard::content-type: text/plain\n",
  mime: "Default application for “text/plain”: editor.desktop\nRegistered applications:\n\tviewer.desktop\n\teditor.desktop\n\tmissing.desktop\nRecommended applications:\n\teditor.desktop\n",
};
const H = globalThis.__herdr = {
  spaces: [], panes: [], focused: null, shared: {}, runs: [], notes: [], overlays: [], currentProps: {},
  calls: 0, hostCalls: 0, rendering: false, visibleRows: Infinity, platform: "linux", appHome: join(base, "app-home"), home: join(base, "home"), execs: [],
  props: () => H.currentProps,
  hyprctl: (args) => ({ code: 0, stdout: args[0] === "-j" ? "[]" : "ok\n", stderr: "" }),
  exec: async (cmd, args, { cwd } = {}) => {
    H.execs.push([cmd, args]);
    if (OPENERS.includes(cmd)) return { code: 0, stdout: "", stderr: "" };
    if (cmd === "gio") return { code: 0, stdout: GIO[args[0]] ?? "", stderr: "" };
    if (cmd === "hyprctl") return H.hyprctl(args);
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  },
  terminals: [],
  hc: async () => ({ code: 0, stdout: "{}", stderr: "" }),
  read: async (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  write: async (p, text, expected) => {
    const now = await H.read(p);
    if (now !== expected) throw new Error("stale snapshot");
    writeFileSync(p, text);
    return null;
  },
  cx: () => cx,
};
const timers = [];
const cx = {
  spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); tasks.push(p); return p; },
  timer: { every: (_ms, fn) => { timers.push(fn); }, after: () => {} },
  notify() { cx.count = (cx.count ?? 0) + 1; }, stop_propagation() {}, write_to_clipboard(t) { H.clipboard = t; }, focus_handle: () => ({ focus() {} }),
  sleep: () => Promise.resolve(),
};
// Waits until git has answered: every task that can finish has. Folder watches never do, so each
// task gets at most a short while, and settling stops once no new tasks appear.
const settle = async () => {
  for (let i = 0; i < 30; i++) {
    const n = tasks.length;
    await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 150))]);
    await new Promise((r) => setTimeout(r, 20));
    if (tasks.length === n && i > 1) break;
  }
};

// Walk a rendered tree: every node, for finding ids and text.
const walk = (node, out = []) => {
  if (node && typeof node === "object" && node.kids) { out.push(node); for (const c of node.kids) walk(c, out); for (const r of node.items ?? []) walk(r, out); }
  return out;
};
const texts = (tree) => walk(tree).flatMap((n) => n.kids.filter((c) => typeof c === "string"));
const byId = (tree, id) => walk(tree).find((n) => n.id === id);
const click = (tree, id) => { const n = byId(tree, id); assert.ok(n, `no element #${id}`); n.handlers.click({ click_count: 1 }, cx); };

// A virtual list's rows hold no handlers: the press says where in the list it landed, then the list names the row.
const LIST_WIDTH = 400;
const listOf = (tree) => walk(tree).find((n) => n.kind === "list" && n.id === panel.listId);
const clickRow = (tree, key, zone = null) => {
  const row = panel.rowsModel().byKey.get(key);
  assert.ok(row, `no row ${key}`);
  const x = zone ? zoneCenter(row, zone, LIST_WIDTH) : 150;
  byId(tree, "git-changes-rows").handlers["mouse_down:left"]({ local_position: { x, y: 10 }, bounds: { x: 0, y: 0, width: LIST_WIDTH, height: 600 }, click_count: 1 }, cx);
  const list = listOf(tree);
  assert.ok(list.keys.includes(key), `the list has no row ${key}`);
  list.handlers.item_click(key, cx);
};

// --- a repository ---------------------------------------------------------------

const repo = join(base, "repo");
const git = (...a) => execFileSync("git", a, { cwd: repo, env, encoding: "utf8" });
mkdirSync(join(repo, "src/ui"), { recursive: true });
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "src/app.ts"), "a\nb\nc\nd\n"); writeFileSync(join(repo, "src/ui/list.ts"), "x\n"); writeFileSync(join(repo, "README.md"), "r\n");
git("add", "."); git("commit", "-qm", "init");
writeFileSync(join(repo, "src/app.ts"), "a\nB\nd\ne\n"); writeFileSync(join(repo, "src/ui/list.ts"), "x\ny\n"); git("add", "src/ui/list.ts");
mkdirSync(join(repo, "docs")); writeFileSync(join(repo, "docs/usage.md"), "u\n");

H.spaces = [{ id: "sp1", name: "repo", active: true, machine: null, folder: repo, tabs: [{ id: "tb1", name: "1", active: true }] }];
H.panes = [{ pane: "p1", tab: "tb1", terminal: "t1", cwd: repo, focused: true }];
H.focused = { space: "sp1", tab: "tb1", pane: "p1", terminal: "t1", cwd: repo };

const { Panel } = await import(pathToFileURL(join(lib, "panel.js")).href);
const { DiffView } = await import(pathToFileURL(join(lib, "diff.js")).href);
const { ForgeView } = await import(pathToFileURL(join(lib, "forge-view.js")).href);
const { Menu } = await import(pathToFileURL(join(lib, "menu.js")).href);
const { zoneCenter } = await import(pathToFileURL(join(lib, "rows.js")).href);

// Exercise the popup's real confirmation and shared-pick protocol, not its callbacks.
const chooseMenu = (overlay, label) => {
  const saved = H.currentProps;
  try {
    H.currentProps = { ...overlay.props, overlay: "test-popup" };
    const menu = new Menu();
    menu.init(cx);
    const i = overlay.props.items.findIndex((it) => it.label === label);
    assert.ok(i >= 0, `no menu item ${label}`);
    menu.choose(i, cx);
    if (overlay.props.items[i].danger) menu.choose(i, cx);
  } finally { H.currentProps = saved; }
};

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${String(e.stack ?? e).split("\n").slice(0, 4).join("\n     ")}`); process.exitCode = 1; }
};

const keepAlive = setInterval(() => {}, 1000);
const panel = new Panel();
H.currentProps = {};
try { panel.init(cx); } catch (e) { console.log("init threw", e); }
await settle();

await test("the panel reads the repository and renders the tree", async () => {
  const tree = panel.render(cx);
  const all = texts(tree);
  assert.ok(all.includes("Tracked") && all.includes("Untracked"), "groups");
  assert.ok(all.includes("src"), "the src folder");
  assert.ok(all.includes("ui"), "the ui folder under src");
  assert.ok(all.includes("app.ts") && all.includes("list.ts") && all.includes("usage.md"), "files");
  assert.ok(byId(tree, "row-folder:tracked:src"), "a folder row with its own id");
});

await test("folding a folder hides what's in it, only in that group", async () => {
  clickRow(panel.render(cx), "folder:tracked:src");
  let all = texts(panel.render(cx));
  assert.ok(!all.includes("app.ts") && !all.includes("list.ts"), "src's files hidden");
  assert.ok(all.includes("usage.md"), "the other group untouched");
  clickRow(panel.render(cx), "folder:tracked:src");
  all = texts(panel.render(cx));
  assert.ok(all.includes("app.ts"), "unfolded again");
});

await test("Flat lists every file with its folder beside it", async () => {
  click(panel.render(cx), "list-flat");
  const tree = panel.render(cx), all = texts(tree);
  assert.equal(panel.listMode, "flat");
  assert.ok(!byId(tree, "row-folder:tracked:src"), "no folder rows");
  assert.ok(all.includes("src/ui") && all.includes("list.ts"), "folder shown beside the name");
  click(tree, "list-tree");
  assert.equal(panel.listMode, "tree");
});

await test("a folder's checkbox stages everything inside it", async () => {
  clickRow(panel.render(cx), "folder:tracked:src", "stage");
  await settle();
  const staged = git("diff", "--cached", "--name-only").trim().split("\n").sort();
  assert.deepEqual(staged, ["src/app.ts", "src/ui/list.ts"]);
  git("reset", "-q", "src/app.ts");
  panel.refresh(cx); await settle();
});

let diff;
await test("clicking a file opens one diff tab in the main area", async () => {
  H.runs = [];
  clickRow(panel.render(cx), "file:src/app.ts");
  const opened = H.runs.find(([n]) => n === "tab.new");
  assert.ok(opened, "tab.new ran");
  assert.equal(opened[1].mod, "git-changes");
  assert.equal(opened[1].props.role, "diff");
  assert.equal(opened[1].name, "app.ts");
  // The tab appears; its copy of the mod starts and claims it.
  H.spaces[0].tabs.push({ id: "tb2", name: "app.ts", active: true }); H.spaces[0].tabs[0].active = false;
  H.panes.push({ pane: "p2", tab: "tb2", terminal: null, mod: "git-changes", focused: true });
  H.focused = { space: "sp1", tab: "tb2", pane: "p2", terminal: null, cwd: null };
  H.currentProps = opened[1].props;
  diff = new DiffView(); diff.init(cx); await settle();
  assert.equal(H.shared["git-changes.view"].sp1.tab, "tb2", "the tab claimed its entry");
});

await test("the diff tab shows the file, one column, with both line numbers", async () => {
  const tree = diff.render(cx), all = texts(tree);
  assert.ok(all.includes("src/app.ts"), "title");
  assert.ok(all.includes("B") && all.includes("b"), "added and removed lines");
  assert.ok(texts(tree).includes("Before") === false, "no column headers in one column");
});

await test("two columns pair removed and added lines, the panel's toggle and the tab's both switch", async () => {
  click(panel.render(cx), "layout-split");
  assert.equal(H.shared["git-changes.layout"], "split");
  const tree = diff.render(cx), all = texts(tree);
  assert.ok(all.includes("Before") && all.includes("After"));
  const list = walk(tree).find((n) => n.kind === "list");
  // b|B is a pair; c has nothing opposite; e is added after d.
  assert.ok(list.items.length >= 5);
  click(tree, "gc-diff-unified");
  assert.equal(H.shared["git-changes.layout"], "unified");
});

await test("the panel keeps its repository while the diff tab has the focus", async () => {
  panel.refresh(cx); await settle();
  assert.equal(panel.root, repo);
  assert.ok(texts(panel.render(cx)).includes("app.ts"));
});

await test("picking another file reuses the tab and renames it", async () => {
  H.runs = [];
  clickRow(panel.render(cx), "file:docs/usage.md");
  assert.ok(!H.runs.some(([n]) => n === "tab.new"), "no second tab");
  assert.deepEqual(H.runs.filter(([n]) => n !== "layout.select").map(([n, a]) => [n, a.id, a.name ?? null]), [["tab.rename", "tb2", "usage.md"], ["tab.select", "tb2", null]]);
  diff.render(cx); // the tab re-renders when shared state changes; that's when it sees the pick
  await settle();
  const all = texts(diff.render(cx));
  assert.ok(all.includes("docs/usage.md"), "retitled");
  assert.ok(all.includes("u"), "the untracked file's text");
});

await test("closing the tab, then picking again, makes a new one", async () => {
  H.spaces[0].tabs = H.spaces[0].tabs.filter((t) => t.id !== "tb2"); H.panes = H.panes.filter((p) => p.tab !== "tb2");
  H.focused = { space: "sp1", tab: "tb1", pane: "p1", terminal: "t1", cwd: repo };
  H.runs = [];
  clickRow(panel.render(cx), "file:src/app.ts");
  assert.ok(H.runs.some(([n]) => n === "tab.new"));
});

await test("History renders the graph and a commit opens in the diff tab", async () => {
  click(panel.render(cx), "tab-history");
  await settle();
  const tree = panel.render(cx);
  assert.ok(texts(tree).includes("init"), "the commit row");
  const list = walk(tree).find((n) => n.kind === "list" && n.id.startsWith("gc-history"));
  H.runs = []; H.shared["git-changes.view"] = {};
  list.handlers.item_click(list.keys[1], cx);
  const opened = H.runs.find(([n]) => n === "tab.new");
  assert.equal(H.shared["git-changes.view"].sp1.item.area, "commit");
  assert.ok(opened && /^[0-9a-f]{7}$/.test(opened[1].name), "named after the short hash");
});

await test("Repo lists only the files the branch's commits changed since main, and opens their diff against the merge base", async () => {
  const branchRepo = join(base, "branch-repo"), bgit = (...a) => execFileSync("git", a, { cwd: branchRepo, env, encoding: "utf8" });
  mkdirSync(join(branchRepo, "lib"), { recursive: true });
  bgit("init", "-q", "-b", "main");
  writeFileSync(join(branchRepo, "base.txt"), "one\n"); bgit("add", "."); bgit("commit", "-qm", "base");
  const mergeBase = bgit("rev-parse", "HEAD").trim();
  bgit("switch", "-qc", "feature");
  writeFileSync(join(branchRepo, "lib/done.ts"), "done\n"); bgit("add", "."); bgit("commit", "-qm", "feature work");
  writeFileSync(join(branchRepo, "base.txt"), "one\ntwo\n"); writeFileSync(join(branchRepo, "loose.md"), "l\n");
  const savedProps = H.currentProps, savedTab = panel.tab;
  try {
    H.currentProps = { folder: branchRepo };
    click(panel.render(cx), "tab-repo");
    await settle();
    let tree = panel.render(cx);
    const all = texts(tree);
    assert.ok(all.includes("lib") && all.includes("done.ts"), "the committed file");
    assert.ok(!all.includes("base.txt") && !all.includes("loose.md"), "no uncommitted or untracked files");
    assert.ok(all.includes("1 file") && all.includes("main"), "the count and the base in the toolbar");
    assert.ok(!byId(tree, "stage-lib/done.ts") && !byId(tree, "discard-lib/done.ts"), "no staging or discard on the branch's files");
    const list = walk(tree).find((n) => n.kind === "list" && n.id === panel.repoListId);
    list.handlers.item_click("folder:branch:lib", cx);
    assert.ok(!texts(panel.render(cx)).includes("done.ts"), "a folder folds");
    list.handlers.item_click("folder:branch:lib", cx);
    H.runs = []; H.shared["git-changes.view"] = {};
    list.handlers.item_click("file:lib/done.ts", cx);
    const shown = H.shared["git-changes.view"].sp1.item;
    assert.deepEqual([shown.area, shown.path, shown.base, shown.baseName], ["base-file", "lib/done.ts", mergeBase, "main"]);
    assert.ok(byId(panel.render(cx), "in-file:lib/done.ts").props.border_color[0] === "#accent", "the shown file is highlighted");
    const view = new DiffView();
    H.currentProps = { role: "diff", space: "sp1" };
    view.init(cx); await settle();
    tree = view.render(cx);
    assert.ok(texts(tree).includes("done") && texts(tree).some((s) => s.startsWith("Commits since main")), "the file's diff against the merge base");
    H.currentProps = { folder: branchRepo };
    click(panel.render(cx), "view-diff-base");
    assert.equal(H.shared["git-changes.view"].sp1.item.area, "base");
  } finally {
    H.currentProps = savedProps;
    panel.setTab(savedTab, cx); await settle();
  }
});

await test("a confirmed file menu cannot discard in a different repository", async () => {
  const other = join(base, "other");
  execFileSync("git", ["clone", "-q", repo, other], { env });
  const path = "src/app.ts", dirty = "B's uncommitted work\n";
  writeFileSync(join(other, path), dirty);
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  panel.fileMenu(panel.entries.find((e) => e.path === path), cx);
  const oldMenu = H.overlays.at(-1);
  H.currentProps = { folder: other };
  panel.refresh(cx); await settle();
  chooseMenu(oldMenu, "Discard changes");
  panel.render(cx); await settle();
  assert.equal(readFileSync(join(other, path), "utf8"), dirty, "B's file must survive A's menu");
});

await test("a delayed result cannot select a replacement menu item", async () => {
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  const file = panel.entries.find((e) => e.path === "src/app.ts");
  panel.fileMenu(file, cx);
  const oldMenu = H.overlays.at(-1);
  panel.fileMenu(file, cx);
  const newMenu = H.overlays.at(-1);
  try {
    chooseMenu(oldMenu, "Stage");
    panel.render(cx); await settle();
    assert.equal(git("diff", "--cached", "--name-only", "--", file.path), "", "old pick must not run the new Stage callback");
    chooseMenu(newMenu, "Stage");
    panel.render(cx); await settle();
    assert.equal(git("diff", "--cached", "--name-only", "--", file.path).trim(), file.path, "the current menu still works");
  } finally { git("reset", "-q", "--", file.path); }
});

await test("a queued menu callback is invalidated by a context switch, even during a read", async () => {
  panel.refresh(cx); await settle();
  const file = panel.entries.find((e) => e.path === "src/app.ts");
  panel.fileMenu(file, cx);
  chooseMenu(H.overlays.at(-1), "Stage");
  panel.render(cx); // Receives the pick, but its spawned callback has not run.
  panel.refresh(cx); // A read is now pending too.
  H.currentProps = { folder: join(base, "other") };
  panel.render(cx);
  H.currentProps = { folder: repo };
  panel.render(cx); // Returning to A must not resurrect its pending callback.
  await settle();
  try { assert.equal(git("diff", "--cached", "--name-only", "--", file.path), ""); }
  finally { git("reset", "-q", "--", file.path); }
});

await test("a menu cannot cross machines with the same repository path", async () => {
  H.currentProps = { folder: repo, on: "machine-a" };
  panel.refresh(cx); await settle(); // The exec stand-in uses the sandbox for both machines.
  const file = panel.entries.find((e) => e.path === "src/app.ts");
  panel.fileMenu(file, cx);
  const oldMenu = H.overlays.at(-1);
  H.currentProps = { folder: repo, on: "machine-b" };
  panel.refresh(cx); await settle();
  chooseMenu(oldMenu, "Stage");
  panel.render(cx); await settle();
  try { assert.equal(git("diff", "--cached", "--name-only", "--", file.path), ""); }
  finally { git("reset", "-q", "--", file.path); }
});

await test("an old amend message read cannot populate the new repository", async () => {
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  const realExec = H.exec;
  let release, started;
  const reading = new Promise((resolve) => { started = resolve; });
  H.exec = (cmd, args, opts) => {
    if (args.includes("--format=%B") && opts.cwd === repo) {
      started();
      return new Promise((resolve) => { release = resolve; });
    }
    return realExec(cmd, args, opts);
  };
  try {
    panel.toggleAmend(cx);
    await reading;
    H.currentProps = { folder: join(base, "other") };
    panel.refresh(cx); await settle();
    panel.toggleAmend(cx); await settle();
    const currentMessage = panel.message;
    panel.message = ""; panel.editor.set_value(""); // The user clears B's prefill while still amending.
    release({ code: 0, stdout: "A's old commit message\n", stderr: "" });
    await settle();
    assert.equal(currentMessage, "init", "B's own amend read completed");
    assert.equal(panel.editor.value(), "", "A's late reply must not overwrite B's editor");
  } finally { H.exec = realExec; }
});

await test("a running commit keeps its target but cannot clear a later context's message", async () => {
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  const realExec = H.exec;
  let release, started, target;
  const committing = new Promise((resolve) => { started = resolve; });
  H.exec = (cmd, args, opts) => {
    if (args[0] === "commit") {
      target = opts;
      started();
      return new Promise((resolve) => { release = resolve; });
    }
    return realExec(cmd, args, opts);
  };
  try {
    panel.message = "original commit"; panel.editor.set_value(panel.message);
    panel.commit(cx, false);
    await committing;
    H.currentProps = { folder: join(base, "other") }; panel.render(cx);
    H.currentProps = { folder: repo }; panel.render(cx);
    panel.message = "new draft"; panel.editor.set_value(panel.message);
    release({ code: 0, stdout: "", stderr: "" });
    await settle();
    assert.equal(target.cwd, repo, "already-started work stays in A");
    assert.equal(panel.editor.value(), "new draft", "the old completion cannot clear the new draft");
  } finally { H.exec = realExec; }
});


// --- hovering, clicking and what a render costs --------------------------------------

const bigRepo = join(base, "big");
const bigGit = (...a) => execFileSync("git", a, { cwd: bigRepo, env, encoding: "utf8" });
const buildBigRepo = (files) => {
  mkdirSync(bigRepo, { recursive: true });
  bigGit("init", "-q", "-b", "main");
  writeFileSync(join(bigRepo, "seed.txt"), "s\n"); bigGit("add", "."); bigGit("commit", "-qm", "seed");
  for (let i = 0; i < files; i++) { const dir = join(bigRepo, `pkg${i % 20}/sub${i % 3}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `f${i}.ts`), "x\n"); }
};
const rendered = (fn) => { H.calls = 0; H.hostCalls = 0; const tree = fn(); return { tree, calls: H.calls, hostCalls: H.hostCalls }; };

await test("hovering a row re-renders nothing: no row listens for hover, and its highlight is native styling", async () => {
  panel.setTab("changes", cx);
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  const tree = panel.render(cx);
  assert.deepEqual(walk(tree).filter((n) => n.handlers.hover).map((n) => n.id), [], "no on_hover handler anywhere in the panel");
  const row = byId(tree, "in-file:src/app.ts");
  assert.ok(row.props.hover, "the row is highlighted by the pointer natively");
  assert.ok(byId(tree, "discard-src/app.ts"), "the discard button is part of the row, not swapped in on hover");
});

await test("a render draws the visible rows only, so it costs the same for 3 files and for 300", async () => {
  buildBigRepo(300);
  H.visibleRows = 30;
  try {
    H.currentProps = { folder: repo };
    panel.refresh(cx); await settle();
    const small = rendered(() => panel.render(cx));
    H.currentProps = { folder: bigRepo };
    panel.refresh(cx); await settle();
    assert.equal(panel.entries.length, 300);
    const big = rendered(() => panel.render(cx));
    assert.equal(listOf(big.tree).keys.length > 300, true, "the list still knows every row, folders included");
    assert.equal(listOf(big.tree).items.length, 30, "only the visible rows are described");
    assert.ok(big.calls < small.calls * 3 && big.calls < 4000, `${big.calls} builder calls for 300 files, ${small.calls} for the small repository`);
    assert.ok(big.hostCalls <= 6, `${big.hostCalls} host reads in one render`);
  } finally { H.visibleRows = Infinity; H.currentProps = { folder: repo }; panel.refresh(cx); await settle(); }
});

await test("a refresh that finds nothing new redraws nothing", async () => {
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  const before = cx.count;
  panel.refresh(cx); await settle();
  panel.refresh(cx); await settle();
  assert.ok(cx.count - before <= 1, `${cx.count - before} redraws for two refreshes of an unchanged repository`);
});

await test("a click on a file's checkbox stages it; on its trash button, it asks first; elsewhere, it opens the diff", async () => {
  H.currentProps = { folder: repo };
  git("reset", "-q"); panel.refresh(cx); await settle();
  clickRow(panel.render(cx), "file:src/app.ts", "stage"); await settle();
  assert.equal(git("diff", "--cached", "--name-only", "--", "src/app.ts").trim(), "src/app.ts");
  clickRow(panel.render(cx), "file:src/app.ts", "stage"); await settle();
  assert.equal(git("diff", "--cached", "--name-only", "--", "src/app.ts").trim(), "");
  const before = readFileSync(join(repo, "src/app.ts"), "utf8");
  clickRow(panel.render(cx), "file:src/app.ts", "discard");
  assert.equal(readFileSync(join(repo, "src/app.ts"), "utf8"), before, "the first click only arms the button");
  assert.ok(texts(panel.render(cx)).includes("Sure?"), "the row asks");
  assert.equal(panel.render(cx) && byId(panel.render(cx), "discard-src/app.ts").props.tooltip[0], "Click again to confirm");
  H.runs = [];
  clickRow(panel.render(cx), "file:src/app.ts");
  assert.ok(H.runs.some(([n]) => n === "tab.new" || n === "tab.select"), "the body opens the diff");
  panel.armed = null;
});

await test("a section's checkbox stages its group and its title folds it", async () => {
  H.currentProps = { folder: repo };
  git("reset", "-q"); panel.refresh(cx); await settle();
  clickRow(panel.render(cx), "section:tracked", "stage"); await settle();
  assert.deepEqual(git("diff", "--cached", "--name-only").trim().split("\n").sort(), ["src/app.ts", "src/ui/list.ts"]);
  git("reset", "-q"); panel.refresh(cx); await settle();
  clickRow(panel.render(cx), "section:tracked");
  assert.ok(!texts(panel.render(cx)).includes("app.ts"), "the tracked group is folded");
  clickRow(panel.render(cx), "section:tracked");
  assert.ok(texts(panel.render(cx)).includes("app.ts"), "and unfolded again");
});

// --- the keyboard ------------------------------------------------------------------

const press = (key, keystroke = key) => byId(panel.render(cx), "git-changes").handlers.key_down({ key, keystroke }, cx);
const highlighted = () => walk(panel.render(cx)).filter((n) => String(n.id).startsWith("in-") && n.props.border_color?.[0] === theme.accent).map((n) => n.id.slice(3));
const shownItem = () => H.shared["git-changes.view"]?.sp1?.item ?? null;
const theme = { accent: "#accent" };

await test("↓ and ↑ select the row below and above: a file opens in the diff tab, a group or a folder only lights up", async () => {
  H.currentProps = { folder: repo };
  git("reset", "-q"); panel.refresh(cx); await settle();
  panel.cursor = {}; H.shared["git-changes.view"] = {};
  const rows = panel.rowsModel().rows, firstFile = rows.findIndex((r) => r.type === "file");
  press("down");
  assert.deepEqual(highlighted(), [rows[0].key], "from no selection, ↓ starts at the first row");
  assert.equal(shownItem(), null, "a group opens nothing");
  assert.equal(H.scrolledTo, 0, "the list scrolls to the row");
  for (let i = 1; i < firstFile; i++) press("down");
  assert.ok(rows[firstFile - 1].type === "folder" && shownItem() === null, "a folder opens nothing");
  press("down");
  assert.equal(shownItem()?.path, rows[firstFile].entry.path, "the file shows in the diff tab");
  assert.deepEqual(highlighted(), [rows[firstFile].key]);
  assert.equal(H.scrolledTo, firstFile);
  press("up");
  assert.deepEqual(highlighted(), [rows[firstFile - 1].key], "↑ goes back to the folder");
  assert.equal(shownItem()?.path, rows[firstFile].entry.path, "and the diff tab keeps the file");
  for (let i = 0; i < rows.length + 2; i++) press("up");
  assert.deepEqual(highlighted(), [rows[0].key], "↑ stops at the first row");
});

await test("← folds the selected group or folder, → unfolds it, ↩ toggles it", async () => {
  H.currentProps = { folder: repo };
  panel.cursor = {}; H.shared["git-changes.view"] = {};
  press("down"); press("down");
  const folder = panel.rowsModel().byKey.get(highlighted()[0]);
  assert.equal(folder.type, "folder");
  press("right");
  assert.ok(panel.rowsModel().byKey.get(folder.key).open, "→ on an open folder keeps it open");
  press("left");
  assert.ok(!panel.rowsModel().byKey.get(folder.key).open, "← folds it");
  assert.deepEqual(highlighted(), [folder.key], "and keeps it selected");
  press("right");
  assert.ok(panel.rowsModel().byKey.get(folder.key).open, "→ unfolds it");
  press("up"); press("enter");
  assert.ok(!texts(panel.render(cx)).includes("app.ts"), "↩ on a group folds it");
  press("enter");
  assert.ok(texts(panel.render(cx)).includes("app.ts"), "and unfolds it");
});

await test("a click moves the keyboard's selection; keys do nothing while the message box has the keyboard", async () => {
  H.currentProps = { folder: repo };
  panel.cursor = {}; H.shared["git-changes.view"] = {};
  clickRow(panel.render(cx), "folder:untracked:docs");
  assert.deepEqual(highlighted(), ["folder:untracked:docs"], "a clicked folder is selected");
  press("right"); press("down");
  assert.equal(shownItem()?.path, "docs/usage.md", "↓ goes on from the clicked row");
  press("up", "alt-up");
  assert.deepEqual(highlighted(), ["file:docs/usage.md"], "an arrow with a modifier is left to Herdr");
  panel.typing = true;
  try {
    press("up");
    assert.deepEqual(highlighted(), ["file:docs/usage.md"], "the arrows stay in the message box");
  } finally { panel.typing = false; }
});

await test("a clicked file keeps the keyboard in the panel, though the diff tab takes it when it opens", async () => {
  H.currentProps = { folder: repo };
  panel.cursor = {}; H.shared["git-changes.view"] = {};
  const handle = panel.handle;
  let focused = 0;
  panel.handle = { focus() { focused++; } };
  try {
    clickRow(panel.render(cx), "file:docs/usage.md");
    assert.equal(shownItem()?.path, "docs/usage.md");
    assert.ok(focused > 0, "the panel takes the keyboard back");
  } finally { panel.handle = handle; }
});

await test("in History, ↓ and ↑ open the commit below and above", async () => {
  H.currentProps = { folder: repo };
  panel.cursor = {}; H.shared["git-changes.view"] = {};
  panel.setTab("history", cx); await settle();
  try {
    const commits = panel.history.commits;
    press("down");
    assert.equal(shownItem()?.area, "all", "the uncommitted row shows every change");
    press("down");
    assert.equal(shownItem()?.hash, commits[1].hash, "the next row opens its commit");
    assert.equal(H.scrolledTo, 1);
    press("up");
    assert.equal(shownItem()?.area, "all");
    assert.ok(!byId(panel.render(cx), "filter"), "History has no file filter");
  } finally { panel.setTab("changes", cx); await settle(); }
});

// --- filtering the files ---------------------------------------------------------------

const typeFilter = (text) => { panel.filterBox.set_value(text); panel.filterBox.handlers.change({}, cx); };
const groupCounts = () => panel.rowsModel().rows.filter((r) => r.type === "section" && r.area !== "stash").map((r) => [r.area, r.count]);

await test("the filter keeps only the files whose path holds the text, ignoring case", async () => {
  H.currentProps = { folder: repo };
  try {
    typeFilter("UI/");
    const all = texts(panel.render(cx));
    assert.ok(all.includes("list.ts"), "the matching file");
    assert.ok(!all.includes("app.ts") && !all.includes("usage.md"), "no other file");
    assert.deepEqual(groupCounts(), [["tracked", 1]], "a group only for the matches, counting them");
    typeFilter("nothing-like-this");
    assert.ok(texts(panel.render(cx)).includes("No files match “nothing-like-this”"));
    click(panel.render(cx), "clear-filter");
    assert.equal(panel.filterBox.value(), "", "the box is empty");
    assert.ok(texts(panel.render(cx)).includes("app.ts"), "every file is back");
    assert.ok(!byId(panel.render(cx), "clear-filter"), "no clear button for an empty filter");
  } finally { panel.clearFilter(cx); }
});

await test("with a filter, a group's checkbox stages only the files it shows", async () => {
  H.currentProps = { folder: repo };
  try {
    typeFilter("app");
    clickRow(panel.render(cx), "section:tracked", "stage");
    await settle();
    assert.deepEqual(git("diff", "--cached", "--name-only").trim().split("\n"), ["src/app.ts"]);
  } finally { git("reset", "-q"); panel.clearFilter(cx); panel.refresh(cx); await settle(); }
});

await test("while the filter has the keyboard, ↓ and ↑ go through the matches, ← → stay in the box and Esc clears it", async () => {
  H.currentProps = { folder: repo };
  panel.cursor = {}; H.shared["git-changes.view"] = {};
  typeFilter("src");
  panel.filtering = true;
  try {
    press("down");
    assert.deepEqual(highlighted(), ["section:tracked"], "↓ selects the first match's group");
    press("left");
    assert.ok(texts(panel.render(cx)).includes("app.ts"), "← leaves the group open");
    for (let i = 0; i < panel.rowsModel().rows.length; i++) press("down");
    assert.match(shownItem()?.path ?? "", /^src\//, "↓ opens a matching file");
    press("escape");
    assert.deepEqual([panel.filter, panel.filterBox.value(), panel.filtering], ["", "", false], "Esc empties the box and leaves it");
    assert.ok(texts(panel.render(cx)).includes("usage.md"), "every file is back");
  } finally { panel.filtering = false; panel.clearFilter(cx); }
});

await test("the filter works the same in Repo, and the toolbar still counts every file", async () => {
  const filterRepo = join(base, "filter-repo"), fgit = (...a) => execFileSync("git", a, { cwd: filterRepo, env, encoding: "utf8" });
  mkdirSync(join(filterRepo, "lib"), { recursive: true });
  fgit("init", "-q", "-b", "main");
  writeFileSync(join(filterRepo, "base.txt"), "one\n"); fgit("add", "."); fgit("commit", "-qm", "base");
  fgit("switch", "-qc", "feature");
  writeFileSync(join(filterRepo, "lib/done.ts"), "done\n"); writeFileSync(join(filterRepo, "notes.md"), "n\n"); fgit("add", "."); fgit("commit", "-qm", "work");
  const savedProps = H.currentProps;
  try {
    H.currentProps = { folder: filterRepo };
    click(panel.render(cx), "tab-repo");
    await settle();
    typeFilter("DONE");
    const all = texts(panel.render(cx));
    assert.ok(all.includes("done.ts") && !all.includes("notes.md"), "only the matching file");
    assert.ok(all.includes("2 files"), "the toolbar counts every file");
    typeFilter("zzz");
    assert.ok(texts(panel.render(cx)).includes("No files match “zzz”"));
  } finally {
    panel.clearFilter(cx); H.currentProps = savedProps;
    panel.setTab("changes", cx); await settle();
  }
});

// --- opening a folder ------------------------------------------------------------------

await test("a file's menu opens its folder in the file manager and in a terminal tab", async () => {
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  H.execs = []; H.runs = [];
  panel.fileMenu(panel.entries.find((e) => e.path === "src/ui/list.ts"), cx);
  const menu = H.overlays.at(-1);
  assert.ok(menu.props.items.some((i) => i.label === "Open folder" && !i.disabled), "Open folder is offered");
  chooseMenu(menu, "Open folder");
  panel.render(cx); await settle();
  assert.deepEqual(H.execs.find(([c]) => OPENERS.includes(c)), ["xdg-open", [join(repo, "src/ui")]]);
  panel.fileMenu(panel.entries.find((e) => e.path === "src/ui/list.ts"), cx);
  chooseMenu(H.overlays.at(-1), "Open in terminal");
  panel.render(cx); await settle();
  assert.deepEqual(H.runs.find(([n]) => n === "tab.new"), ["tab.new", { space: "sp1", folder: join(repo, "src/ui"), name: "ui" }]);
});

await test("a file in the repository's root opens the root; a folder row opens that folder", async () => {
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  H.execs = [];
  panel.fileMenu({ path: "README.md", staged: "none", status: "M" }, cx);
  chooseMenu(H.overlays.at(-1), "Open folder");
  panel.render(cx); await settle();
  assert.deepEqual(H.execs.find(([c]) => OPENERS.includes(c))[1], [repo]);
  H.execs = [];
  panel.folderMenu(panel.rowsModel().byKey.get("folder:tracked:src"), cx);
  assert.ok(H.overlays.at(-1).props.items.some((i) => i.label === "Copy full path" && i.copy === join(repo, "src")));
  chooseMenu(H.overlays.at(-1), "Open folder");
  panel.render(cx); await settle();
  assert.deepEqual(H.execs.find(([c]) => OPENERS.includes(c))[1], [join(repo, "src")]);
});

await test("right-clicking a folder row opens its menu; stage folder stages what's inside", async () => {
  H.currentProps = { folder: repo };
  git("reset", "-q"); panel.refresh(cx); await settle();
  listOf(panel.render(cx)).handlers.item_secondary_click("folder:tracked:src", {}, cx);
  assert.equal(H.overlays.at(-1).props.items[0].label, "Stage folder");
  chooseMenu(H.overlays.at(-1), "Stage folder");
  panel.render(cx); await settle();
  assert.deepEqual(git("diff", "--cached", "--name-only").trim().split("\n").sort(), ["src/app.ts", "src/ui/list.ts"]);
  git("reset", "-q"); panel.refresh(cx); await settle();
});

await test("on another machine, Open folder is off but a terminal tab still opens", async () => {
  H.currentProps = { folder: repo, on: "machine-a" };
  panel.refresh(cx); await settle();
  panel.fileMenu(panel.entries.find((e) => e.path === "src/app.ts"), cx);
  const open = H.overlays.at(-1).props.items.find((i) => i.label === "Open folder");
  assert.equal(open.disabled, true);
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
});

// --- open with -------------------------------------------------------------------------

const userApps = join(base, "home/.local/share/applications"), systemApps = join(base, "system/applications");
mkdirSync(userApps, { recursive: true }); mkdirSync(systemApps, { recursive: true });
writeFileSync(join(userApps, "editor.desktop"), "[Desktop Entry]\nName[de]=Bearbeiter\nName=Editor\n[Desktop Action new]\nName=New window\n");
writeFileSync(join(systemApps, "viewer.desktop"), "[Desktop Entry]\nType=Application\nName=Viewer\n");
writeFileSync(join(systemApps, "editor.desktop"), "[Desktop Entry]\nName=System editor\n");
const savedXdg = { home: process.env.XDG_DATA_HOME, dirs: process.env.XDG_DATA_DIRS };
delete process.env.XDG_DATA_HOME; process.env.XDG_DATA_DIRS = join(base, "system");

await test("Open with lists the file type's applications, the default first, and opens the file with the one picked", async () => {
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  H.execs = [];
  panel.fileMenu(panel.entries.find((e) => e.path === "src/app.ts"), cx);
  chooseMenu(H.overlays.at(-1), "Open with…");
  panel.render(cx); await settle();
  const apps = H.overlays.at(-1).props.items;
  assert.deepEqual(apps.map((i) => [i.label, i.hint]), [["Editor", "default"], ["Viewer", ""]]);
  assert.deepEqual(H.execs.filter(([c]) => c === "gio").map(([, a]) => a), [["info", "-a", "standard::content-type", "--", join(repo, "src/app.ts")], ["mime", "text/plain"]]);
  chooseMenu(H.overlays.at(-1), "Viewer");
  panel.render(cx); await settle();
  const command = `'gio' 'launch' '${join(systemApps, "viewer.desktop")}' '${join(repo, "src/app.ts")}'`;
  assert.deepEqual(H.execs.find(([c, a]) => c === "hyprctl" && a[0] === "dispatch"), ["hyprctl", ["dispatch", `hl.dsp.exec_cmd("${command}", { float = true })`]]);
});

await test("without Hyprland's Lua dispatch the older one floats the window, and without Hyprland gio opens it", async () => {
  const { launch, floatingLaunches } = await import(pathToFileURL(join(lib, "apps.js")).href);
  const app = { path: "/apps/viewer.desktop", name: "Viewer", wmClass: null }, file = "/repo/it's \"odd\" $HOME.ts";
  const dispatches = () => H.execs.filter(([c, a]) => c === "gio" || a[0] === "dispatch");
  assert.deepEqual(floatingLaunches(`gio launch '${file}'`)[0][1], `hl.dsp.exec_cmd("gio launch '/repo/it's \\"odd\\" $HOME.ts'", { float = true })`);
  const saved = H.hyprctl;
  try {
    H.hyprctl = (args) => ({ code: 0, stdout: args[0] === "-j" ? "[]" : args[1] === "exec" ? "ok" : "Invalid dispatcher", stderr: "" });
    H.execs = [];
    await launch(app, file, cx.sleep);
    assert.deepEqual(dispatches().map(([c, a]) => [c, a[1]]), [["hyprctl", dispatches()[0][1][1]], ["hyprctl", "exec"]]);
    assert.equal(dispatches()[1][1][2], `[float] 'gio' 'launch' '/apps/viewer.desktop' '/repo/it'\\''s "odd" $HOME.ts'`);
    H.hyprctl = () => ({ code: 1, stdout: "", stderr: "HYPRLAND_INSTANCE_SIGNATURE not set" });
    H.execs = [];
    await launch(app, file, cx.sleep);
    assert.deepEqual(dispatches(), [["gio", ["launch", app.path, file]]]);
  } finally { H.hyprctl = saved; }
});

await test("an application that detaches from its launch, like VS Code, gets its new window floated; other windows stay as they are", async () => {
  const { launch } = await import(pathToFileURL(join(lib, "apps.js")).href);
  const app = { path: "/apps/code.desktop", name: "Visual Studio Code", wmClass: "com.microsoft.VSCode" };
  const editor = { address: "0xb", class: "com.microsoft.VSCode", floating: false }, other = { address: "0xc", class: "chromium", floating: false };
  const saved = H.hyprctl;
  const run = async (opened) => {
    let launched = false;
    H.hyprctl = (args) => {
      if (args[0] === "-j") return { code: 0, stdout: JSON.stringify([{ address: "0xa", class: "foot", floating: false }, ...(launched ? opened : [])]), stderr: "" };
      launched = true;
      return { code: 0, stdout: "ok", stderr: "" };
    };
    H.execs = [];
    await launch(app, "/repo/README.md", cx.sleep);
    return H.execs.filter(([, a]) => a[0] === "dispatch").slice(1).map(([, a]) => a[1]);
  };
  try {
    assert.deepEqual(await run([other, editor]), ['hl.dsp.window.float({ action = "on", window = "address:0xb" })']);
    assert.deepEqual(await run([{ ...editor, floating: true }]), [], "a window the launch rule floated is left alone");
    assert.deepEqual(await run([other]), [], "a file handed to an open VS Code floats nothing");
  } finally { H.hyprctl = saved; }
});

await test("Open with is off for a deleted file, on another machine and off Linux", async () => {
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  const openWith = () => H.overlays.at(-1).props.items.find((i) => i.label === "Open with…");
  panel.fileMenu({ path: "gone.ts", staged: "none", status: "D" }, cx);
  assert.equal(openWith().disabled, true);
  H.platform = "macos";
  try {
    panel.fileMenu(panel.entries.find((e) => e.path === "src/app.ts"), cx);
    assert.deepEqual([openWith().disabled, openWith().hint], [true, "Linux only"]);
  } finally { H.platform = "linux"; }
  H.currentProps = { folder: repo, on: "machine-a" };
  panel.refresh(cx); await settle();
  panel.fileMenu(panel.entries.find((e) => e.path === "src/app.ts"), cx);
  assert.deepEqual([openWith().disabled, openWith().hint], [true, "this computer only"]);
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
});

await test("Open with says so when no application opens the file", async () => {
  H.currentProps = { folder: repo };
  panel.refresh(cx); await settle();
  const savedMime = GIO.mime;
  GIO.mime = "No default applications for “text/plain”\nNo registered applications\n";
  try {
    const menus = H.overlays.length;
    panel.fileMenu(panel.entries.find((e) => e.path === "src/app.ts"), cx);
    chooseMenu(H.overlays.at(-1), "Open with…");
    panel.render(cx); await settle();
    assert.equal(H.overlays.length, menus + 1, "no second menu opens");
    assert.equal(panel.note, "No application opens this file");
  } finally { GIO.mime = savedMime; panel.note = null; }
});

if (savedXdg.home === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedXdg.home;
if (savedXdg.dirs === undefined) delete process.env.XDG_DATA_DIRS; else process.env.XDG_DATA_DIRS = savedXdg.dirs;

// --- images ----------------------------------------------------------------------------

const picRepo = join(base, "pics");
const picGit = (...a) => execFileSync("git", a, { cwd: picRepo, env, encoding: "utf8" });
const pic = (name, bytes) => writeFileSync(join(picRepo, name), bytes);
mkdirSync(join(picRepo, "art"), { recursive: true });
picGit("init", "-q", "-b", "main");
pic("art/hero.png", png(4, 3, [200, 0, 0])); pic("art/old.png", png(2, 2, [0, 0, 200])); pic("art/logo.svg", svgText(10, 10)); pic("notes.txt", "n\n");
picGit("add", "."); picGit("commit", "-qm", "art");
pic("art/hero.png", png(8, 6, [0, 200, 0])); pic("art/logo.svg", svgText(20, 10)); rmSync(join(picRepo, "art/old.png")); pic("art/new.png", png(5, 5, [9, 9, 9]));

const openDiff = async (item, root = picRepo) => {
  const saved = H.currentProps;
  H.shared["git-changes.view"] = { sp1: { item, source: { root, on: null }, at: Date.now(), tab: "tb9" } };
  H.currentProps = { role: "diff", space: "sp1" };
  const view = new DiffView(); view.init(cx); await settle();
  H.currentProps = saved;
  return view;
};
const pictures = (tree) => walk(tree).filter((n) => n.kind === "image").map((n) => n.props.path[0]);

await test("an image's diff shows the new picture, the old one and what changed, for every kind of change", async () => {
  const view = await openDiff({ area: "all" });
  const rows = view.rows.filter((r) => r.kind === "img");
  assert.deepEqual(rows.map((r) => [r.path, r.change]), [["art/hero.png", "modified"], ["art/logo.svg", "modified"], ["art/old.png", "deleted"], ["art/new.png", "added"]]);
  const tree = view.render(cx), shown = pictures(tree);
  assert.equal(shown.length, 6, "hero and logo before and after, new after, old before");
  for (const src of shown) { assert.match(src, /^data\/git-changes\/preview\/.+\.(png|svg)$/); assert.ok(readFileSync(join(H.appHome, src)).length > 0, `${src} was copied under the app's folder`); }
  const all = texts(tree);
  assert.ok(all.includes("Before") && all.includes("After"));
  assert.ok(all.includes("4 × 3 · " + all.find((t) => t.startsWith("4 × 3 · ")).slice(8)), "the old size");
  assert.ok(all.some((t) => t.startsWith("8 × 6")), "the new size");
  assert.ok(!all.includes("Added: no image before"), "one column: an added image shows only its After cell");
  H.shared["git-changes.layout"] = "split";
  const split = texts(view.render(cx));
  H.shared["git-changes.layout"] = "unified";
  assert.ok(split.includes("Added: no image before") && split.includes("Deleted: no image after"), "two columns: the empty side says why");
  assert.equal(pictures(view.render(cx)).length, 6);
});

await test("a single image diff in one column stacks before over after; in two columns it sits side by side", async () => {
  const view = await openDiff({ area: "file", path: "art/hero.png", status: "M", staged: "none" });
  view.bodyWidth = 800; view.bodyHeight = 600; view.imageVersion++;
  const stacked = walk(view.render(cx)).find((n) => n.kind === "list");
  const side = (layout) => { H.shared["git-changes.layout"] = layout; const tree = view.render(cx); return { tree, list: walk(tree).find((n) => n.kind === "list") }; };
  assert.equal(stacked.items.length, 1, "one row for the one image");
  assert.equal(pictures(view.render(cx)).length, 2);
  const one = side("unified"), two = side("split");
  assert.ok(one.list.sizes[0] > two.list.sizes[0], "stacked is taller than side by side");
  assert.ok(texts(two.tree).includes("Before") && texts(two.tree).includes("After"));
  H.shared["git-changes.layout"] = "unified";
});

await test("an untracked image shows only the new picture", async () => {
  const view = await openDiff({ area: "file", path: "art/new.png", untracked: true, status: "A", staged: "none" });
  assert.equal(pictures(view.render(cx)).length, 1);
  assert.ok(texts(view.render(cx)).includes("After"));
});

await test("a deleted image shows the old picture", async () => {
  const view = await openDiff({ area: "file", path: "art/old.png", status: "D", staged: "none" });
  assert.equal(pictures(view.render(cx)).length, 1);
  assert.ok(texts(view.render(cx)).includes("Before"));
});

await test("in History, a commit that touches images shows them, and so does a stash", async () => {
  picGit("add", "-A"); picGit("commit", "-qm", "new art");
  const hash = picGit("rev-parse", "HEAD").trim();
  const commit = await openDiff({ area: "commit", hash, short: hash.slice(0, 7), subject: "new art" });
  assert.equal(pictures(commit.render(cx)).length, 6);
  pic("art/hero.png", png(3, 3, [1, 2, 3])); pic("art/extra.png", png(6, 6, [5, 5, 5]));
  picGit("stash", "push", "--include-untracked", "-m", "wip");
  const stash = await openDiff({ area: "stash", ref: "stash@{0}", subject: "wip" });
  assert.equal(stash.imageRows.length, 2);
  assert.equal(pictures(stash.render(cx)).length, 3, "hero before and after, extra from the stash's untracked commit");
});

await test("an image too large to preview says so instead of loading", async () => {
  const { previewSide } = await import(pathToFileURL(join(lib, "images.js")).href);
  const big = Buffer.alloc(11 * 1024 * 1024, 1);
  writeFileSync(join(picRepo, "huge.png"), big);
  const result = await previewSide({ worktree: "huge.png" }, "png", { root: picRepo, on: null });
  assert.match(result.error, /Too large to preview \(11\.0 MB\)/);
  assert.equal((await previewSide({ worktree: "huge.png" }, "png", { root: picRepo, on: "machine-a" })).error, "Image preview works on this computer only");
  assert.equal(await previewSide(null, "png", { root: picRepo, on: null }), null);
});

// --- markdown preview ------------------------------------------------------------

const docsRepo = join(base, "docs");
const docsGit = (...a) => execFileSync("git", a, { cwd: docsRepo, env, encoding: "utf8" });
mkdirSync(docsRepo);
docsGit("init", "-q", "-b", "main");
writeFileSync(join(docsRepo, "guide.md"), "# Guide\n\nold\n"); writeFileSync(join(docsRepo, "code.ts"), "a\n");
docsGit("add", "."); docsGit("commit", "-qm", "docs");
writeFileSync(join(docsRepo, "guide.md"), "# Guide\n\nnew\n"); writeFileSync(join(docsRepo, "code.ts"), "b\n"); writeFileSync(join(docsRepo, "draft.md"), "# Draft\n");

const markdownShown = (tree) => walk(tree).filter((n) => n.kind === "markdown").map((n) => n.props.markdown[0]);
const preview = async (item) => {
  const view = await openDiff(item, docsRepo);
  click(view.render(cx), "gc-diff-preview");
  return view;
};

await test("a markdown file's diff can switch to its rendered preview and back", async () => {
  const view = await openDiff({ area: "file", path: "guide.md", status: "M", staged: "none" }, docsRepo);
  assert.deepEqual(markdownShown(view.render(cx)), [], "the diff shows first");
  click(view.render(cx), "gc-diff-preview");
  const tree = view.render(cx);
  assert.deepEqual(markdownShown(tree), ["# Guide\n\nnew\n"], "one column: the new version");
  assert.equal(walk(tree).some((n) => n.kind === "list"), false, "the preview takes the diff's place");
  click(tree, "gc-diff-changes");
  assert.deepEqual(markdownShown(view.render(cx)), []);
});

await test("in two columns, the preview shows the markdown before and after", async () => {
  const view = await preview({ area: "file", path: "guide.md", status: "M", staged: "none" });
  H.shared["git-changes.layout"] = "split";
  const shown = markdownShown(view.render(cx));
  H.shared["git-changes.layout"] = "unified";
  assert.deepEqual(shown, ["# Guide\n\nold\n", "# Guide\n\nnew\n"]);
});

await test("an untracked markdown file previews its text, and has nothing before it", async () => {
  const view = await preview({ area: "file", path: "draft.md", untracked: true, status: "A", staged: "none" });
  assert.deepEqual(markdownShown(view.render(cx)), ["# Draft\n"]);
  H.shared["git-changes.layout"] = "split";
  const tree = view.render(cx);
  H.shared["git-changes.layout"] = "unified";
  assert.deepEqual(markdownShown(tree), ["# Draft\n"]);
  assert.ok(texts(tree).includes("Not in this version"));
});

await test("a markdown file of the repo tab previews its version on the branch", async () => {
  const head = docsGit("rev-parse", "HEAD").trim();
  docsGit("add", "guide.md"); docsGit("commit", "-qm", "guide");
  const next = docsGit("rev-parse", "HEAD").trim();
  const view = await preview({ area: "base-file", path: "guide.md", base: head, head: next, baseName: "main" });
  assert.deepEqual(markdownShown(view.render(cx)), ["# Guide\n\nnew\n"]);
});

await test("other files and whole-commit diffs have no preview switch", async () => {
  const code = await openDiff({ area: "file", path: "code.ts", status: "M", staged: "none" }, docsRepo);
  assert.equal(byId(code.render(cx), "gc-diff-preview"), undefined);
  const all = await openDiff({ area: "all" }, docsRepo);
  assert.equal(byId(all.render(cx), "gc-diff-preview"), undefined);
});

const M = await import(pathToFileURL(join(lib, "mermaid.js")).href);
const mermaidCalls = [];
const withMermaid = async (answer, fn) => {
  const real = H.exec;
  H.exec = async (cmd, args, opts) => (cmd === "mmdc" ? (mermaidCalls.push(args), answer(args)) : real(cmd, args, opts));
  try { await fn(); } finally { H.exec = real; }
};
const drawPicture = (args) => { writeFileSync(args[args.indexOf("-o") + 1], png(40, 20, [1, 2, 3])); return { code: 0, stdout: "", stderr: "" }; };
const previewWithDiagram = async (name, source) => {
  writeFileSync(join(docsRepo, name), `# Flow\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nAfter\n`);
  const view = await preview({ area: "file", path: name, untracked: true, status: "A", staged: "none" });
  view.render(cx); await settle();
  return view.render(cx);
};

await test("mermaid blocks are cut out of the markdown, but not from inside another fence", async () => {
  const text = ["# T", "```mermaid", "graph TD", "```", "mid", "````md", "```mermaid", "x", "```", "````", "~~~ Mermaid", "pie", "~~~", "```mermaid", "open"].join("\n");
  assert.deepEqual(M.splitMermaid(text), [
    { kind: M.Part.Markdown, text: "# T" },
    { kind: M.Part.Mermaid, source: "graph TD" },
    { kind: M.Part.Markdown, text: "mid\n````md\n```mermaid\nx\n```\n````" },
    { kind: M.Part.Mermaid, source: "pie" },
    { kind: M.Part.Mermaid, source: "open" },
  ]);
  assert.deepEqual(M.splitMermaid("plain\n"), [{ kind: M.Part.Markdown, text: "plain\n" }]);
  assert.equal(M.isDarkColor("#1e1e2e"), true); assert.equal(M.isDarkColor("#fafafa"), false); assert.equal(M.isDarkColor("teal"), false);
});

await test("the preview draws a mermaid diagram as a picture between the markdown around it, once", async () => {
  mermaidCalls.length = 0;
  await withMermaid(drawPicture, async () => {
    const tree = await previewWithDiagram("flow.md", "graph TD\n  A --> B");
    assert.deepEqual(markdownShown(tree), ["# Flow\n", "\nAfter\n"]);
    const [src] = pictures(tree);
    assert.match(src, /^data\/git-changes\/preview\/mermaid-[0-9a-f]{32}\.png$/);
    assert.ok(readFileSync(join(H.appHome, src)).length > 0, "the picture is under the app's folder");
    assert.deepEqual(walk(tree).find((n) => n.kind === "image").props.w, [20], "shown at half its pixels: drawn at twice the size");
    assert.equal(mermaidCalls.length, 1);
    assert.deepEqual(mermaidCalls[0].slice(-4), ["-b", "transparent", "-s", "2"]);
    await previewWithDiagram("flow.md", "graph TD\n  A --> B");
    assert.equal(mermaidCalls.length, 1, "the same diagram again comes from the cache");
  });
});

await test("a diagram mermaid can't draw shows why, with its source", async () => {
  await withMermaid(() => ({ code: 1, stdout: "", stderr: "\nError: Parse error on line 2:\n...\n" }), async () => {
    const tree = await previewWithDiagram("broken.md", "graph TD\n  A -->");
    assert.ok(texts(tree).includes("Error: Parse error on line 2:"));
    assert.ok(markdownShown(tree).includes("```mermaid\ngraph TD\n  A -->\n```"));
    assert.deepEqual(pictures(tree), []);
  });
  await withMermaid(() => ({ code: 127, stdout: "", stderr: "" }), async () => {
    assert.ok(texts(await previewWithDiagram("missing.md", "pie\n  \"a\": 1")).includes(M.INSTALL_HINT));
  });
});

// --- comment threads ------------------------------------------------------------

const talkRepo = join(base, "talk");
const talkGit = (...a) => execFileSync("git", a, { cwd: talkRepo, env, encoding: "utf8" });
mkdirSync(talkRepo);
talkGit("init", "-q", "-b", "main");
writeFileSync(join(talkRepo, "notes.ts"), "one\ntwo\nthree\n");
talkGit("add", "."); talkGit("commit", "-qm", "notes");
writeFileSync(join(talkRepo, "notes.ts"), "one\nTWO\nthree\n");

const MAIN_SESSION = "11111111-1111-4111-8111-111111111111";
const projectOf = (cwd) => join(claudeHome, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
const sessions = projectOf(talkRepo);
const addSession = (dir, id, age) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
  const at = new Date(Date.now() - age * 1000);
  utimesSync(join(dir, `${id}.jsonl`), at, at);
};
addSession(sessions, MAIN_SESSION, 60);

// Stand-in for hc: `run` starts a live terminal that Herdr lists, `send` and `peek` are recorded, `kill` ends it.
const hcCalls = [];
let terminalCount = 0;
H.hc = async (args) => {
  hcCalls.push(args);
  if (args[0] === "run") {
    if (H.hcFails) return { code: 1, stdout: "", stderr: H.hcFails };
    const opt = (name) => args[args.indexOf(name) + 1], [labelKey, labelValue] = opt("--label").split("=");
    const address = `t${100 + ++terminalCount}`;
    H.terminals.push({ address, name: opt("--name"), labels: { [labelKey]: labelValue }, state: "live", status: "working", cwd: opt("--cwd") });
    return { code: 0, stdout: JSON.stringify({ address, state: "live" }), stderr: "" };
  }
  if (args[0] === "kill") { const t = H.terminals.find((x) => x.address === args[1]); if (t) t.state = "finished"; }
  if (args[0] === "read") { const id = args.at(-1); return { code: 0, stdout: H.terminalScreens?.[id] ?? "", stderr: "" }; }
  return { code: 0, stdout: "{}", stderr: "" };
};
const runs = () => hcCalls.filter((a) => a[0] === "run");
const claudeOf = (call) => call.slice(call.indexOf("--") + 1);

const openTalk = async (root = talkRepo) => {
  const saved = H.currentProps;
  H.shared["git-changes.view"] = { sp1: { item: { area: "file", path: "notes.ts", status: "M", staged: "none" }, source: { root, on: null }, at: Date.now(), tab: "tb9" } };
  H.currentProps = { role: "diff", space: "sp1" };
  const view = new DiffView(); view.init(cx); await settle();
  H.currentProps = saved;
  view.bodyWidth = 800;
  return view;
};
const diffList = (tree) => walk(tree).find((n) => n.kind === "list");
const lineKey = (view, text) => `r${view.rows.findIndex((r) => r.text === text)}`;
const threadKeys = (view) => diffList(view.render(cx)).keys.filter((k) => k.startsWith("t"));
const threadOf = (view, text) => view.comments.find((c) => c.text === text);
const terminalOf = (c) => H.terminals.find((t) => t.address === c.terminal);
const comment = async (view, key, text) => {
  diffList(view.render(cx)).handlers.item_click(key, cx);
  assert.ok(diffList(view.render(cx)).keys.includes("compose"), "the comment box opened under the line");
  view.composer.set_value(text);
  view.composer.handlers.submit({ secondary: true }, cx);
  await settle();
};
// The session answers: its file gets the prompt and the answer, its terminal goes idle, and the tab looks.
const answerIn = async (view, lineText, text) => {
  const c = threadOf(view, lineText), file = join(projectOf(c.cwd), `${c.session}.jsonl`);
  mkdirSync(projectOf(c.cwd), { recursive: true });
  const records = [
    { type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "the question" } },
    { type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
    { type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", content: "..." }] } },
    { type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] } },
  ];
  writeFileSync(file, (readdirSync(projectOf(c.cwd)).includes(`${c.session}.jsonl`) ? readFileSync(file, "utf8") : "") + records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const t = terminalOf(c); if (t) t.status = "idle";
  view.pollAnswers(cx); await settle();
};
const savedComments = () => JSON.parse(readFileSync(join(talkRepo, ".git/git-changes-comments.json"), "utf8")).comments;

let talk;
await test("a comment on a line starts an interactive copy of the session as a sub-agent, and its answer shows under the line", async () => {
  talk = await openTalk();
  await comment(talk, lineKey(talk, "TWO"), "Why uppercase?");
  const [call] = runs(), c = threadOf(talk, "TWO");
  const opt = (name) => call[call.indexOf(name) + 1];
  assert.equal(opt("--cwd"), talkRepo, "in the session's own folder, so its .claude settings load");
  assert.ok(call.includes("--no-parent") && call.includes("--no-notify") && call.includes("--outlive-parent"));
  assert.equal(opt("--label"), `git-changes=${c.id}`);
  const claude = claudeOf(call), flag = (name) => claude[claude.indexOf(name) + 1];
  assert.deepEqual(claude.slice(0, 4), ["claude", "--resume", MAIN_SESSION, "--fork-session"]);
  assert.match(flag("--session-id"), /^c0ffee00-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(flag("--name"), "Review: notes.ts:2");
  assert.ok(!claude.includes("-p") && !claude.includes("--tools"), "interactive, with the project's own tools and permissions");
  const prompt = claude.at(-1);
  assert.equal(claude.at(-2), "--");
  assert.ok(prompt.includes("notes.ts, line 2 (added): TWO") && prompt.includes("+TWO") && prompt.includes("My comment: Why uppercase?"), prompt);
  const waiting = talk.render(cx);
  assert.ok(texts(waiting).includes("Thinking…") && walk(waiting).some((n) => n.props.frames), "a spinner while it works");
  assert.ok(texts(waiting).includes(`Session review-${c.id} is open · right-click → Open session`));
  await answerIn(talk, "TWO", "Because TWO reads as a constant.");
  const tree = talk.render(cx), list = diffList(tree), all = texts(tree);
  assert.ok(all.includes("Why uppercase?") && all.includes("Because TWO reads as a constant."), "question and the last answer of the turn");
  assert.equal(list.keys[list.keys.indexOf(lineKey(talk, "TWO")) + 1], threadKeys(talk)[0], "the thread sits right under its line");
  assert.ok(!list.keys.includes("compose"), "the box closed after sending");
  const lineHeights = walk(tree).flatMap((n) => n.props.line_height ?? []);
  assert.ok(lineHeights.length && lineHeights.every((h) => typeof h === "string" && h.endsWith("px")), "a bare number is a multiplier in Herdr: line heights are pixels");
  const [saved] = savedComments();
  assert.equal(saved.session, flag("--session-id"));
  assert.equal(saved.terminal, "t101");
  assert.deepEqual(saved.thread.map((m) => m.from), ["you", "claude"]);
});

await test("a reply is typed into the open session; once that session is closed, a reply opens it again", async () => {
  await comment(talk, threadKeys(talk)[0], "Should I rename it?");
  assert.deepEqual(hcCalls.at(-1), ["send", "t101", "Should I rename it?"]);
  await answerIn(talk, "TWO", "Yes, rename it.");
  assert.ok(texts(talk.render(cx)).includes("Yes, rename it."));
  terminalOf(threadOf(talk, "TWO")).state = "finished";
  await comment(talk, threadKeys(talk)[0], "Then do it.");
  const claude = claudeOf(runs().at(-1)), c = threadOf(talk, "TWO");
  assert.deepEqual([...claude.slice(0, 3), claude.at(-1)], ["claude", "--resume", c.session, "Then do it."]);
  assert.ok(!claude.includes("--fork-session"), "the thread's own copy, not a new fork");
  assert.equal(c.terminal, "t102");
  await answerIn(talk, "TWO", "Renamed it to two.");
  assert.ok(texts(talk.render(cx)).includes("Renamed it to two."));
});

await test("a new thread forks the person's session, never a copy; while its session waits for permission the thread says so, and Open session peeks at it", async () => {
  await comment(talk, lineKey(talk, "three"), "What is this for?");
  assert.equal(claudeOf(runs().at(-1))[2], MAIN_SESSION, "copies (c0ffee00-…) are newer but skipped");
  const c = threadOf(talk, "three");
  terminalOf(c).status = "blocked";
  talk.pollAnswers(cx); await settle();
  assert.ok(texts(talk.render(cx)).includes("Waiting for you in its session · right-click → Open session"));
  diffList(talk.render(cx)).handlers.item_secondary_click(`t${c.id}`, {}, cx);
  H.runs = [];
  chooseMenu(H.overlays.at(-1), "Open session");
  talk.render(cx); await settle();
  assert.deepEqual(H.runs.at(-1), ["terminal.peek", { terminal: c.terminal }]);
  await answerIn(talk, "three", "It closes the list.");
  assert.equal(threadKeys(talk).length, 2);
});

await test("threads are kept in the git folder and follow their line when lines above it change", async () => {
  writeFileSync(join(talkRepo, "notes.ts"), "zero\none\nTWO\nthree\n");
  const view = await openTalk(), list = diffList(view.render(cx));
  const under = (text) => list.keys[list.keys.indexOf(lineKey(view, text)) + 1];
  assert.ok(under("TWO").startsWith("t") && under("three").startsWith("t"), list.keys.join(" "));
  assert.ok(texts(view.render(cx)).includes("Renamed it to two."));
  talk = view;
});

await test("a session that can't start says why, and Ask again in the thread's menu tries once more", async () => {
  H.hcFails = "no claude here";
  await comment(talk, lineKey(talk, "zero"), "Is this needed?");
  assert.ok(texts(talk.render(cx)).includes("no claude here"));
  H.hcFails = null;
  diffList(talk.render(cx)).handlers.item_secondary_click(`t${threadOf(talk, "zero").id}`, {}, cx);
  chooseMenu(H.overlays.at(-1), "Ask again");
  talk.render(cx); await settle();
  await answerIn(talk, "zero", "No, drop it.");
  assert.ok(texts(talk.render(cx)).includes("No, drop it."));
});

await test("a session closed before it answered says so", async () => {
  await comment(talk, threadKeys(talk).find((k) => k === `t${threadOf(talk, "zero").id}`), "Sure?");
  terminalOf(threadOf(talk, "zero")).state = "finished";
  talk.pollAnswers(cx); await settle();
  assert.ok(texts(talk.render(cx)).includes("Its session ended without an answer · right-click → Ask again"));
});

await test("Delete thread ends its session and deletes the copy's files, not the person's session", async () => {
  const c = threadOf(talk, "three");
  diffList(talk.render(cx)).handlers.item_secondary_click(`t${c.id}`, {}, cx);
  chooseMenu(H.overlays.at(-1), "Delete thread");
  talk.render(cx); await settle();
  assert.ok(!texts(talk.render(cx)).includes("It closes the list."));
  assert.ok(!savedComments().some((x) => x.text === "three"), "gone from the file");
  assert.ok(hcCalls.some((a) => a[0] === "kill" && a[1] === c.terminal), "its terminal is ended");
  assert.ok(!readdirSync(sessions).includes(`${c.session}.jsonl`), "its copy is deleted");
  assert.ok(readdirSync(sessions).includes(`${MAIN_SESSION}.jsonl`), "the person's own session is kept");
});

await test("Escape closes the comment box; in two columns the pressed side picks the line", async () => {
  H.shared["git-changes.layout"] = "split";
  const tree = talk.render(cx), pair = `r${talk.pairs.findIndex((p) => p.left?.text === "two")}`;
  byId(tree, `${talk.listId}-split`).handlers["mouse_down:left"]({ local_position: { x: 50, y: 5 }, bounds: { x: 0, y: 0, width: 800, height: 600 } }, cx);
  diffList(tree).handlers.item_click(pair, cx);
  assert.equal(talk.target.anchor.kind, "-");
  byId(talk.render(cx), "git-changes-diff").handlers.key_down({ key: "escape" }, cx);
  assert.equal(talk.target, null);
  assert.ok(!diffList(talk.render(cx)).keys.includes("compose"));
  H.shared["git-changes.layout"] = "unified";
});

await test("Enter sends and Shift+Enter doesn't", async () => {
  const key = `t${threadOf(talk, "TWO").id}`;
  diffList(talk.render(cx)).handlers.item_click(key, cx);
  talk.composer.set_value("And the tests?");
  talk.composer.handlers.submit({ shift: true }, cx);
  assert.ok(talk.target, "Shift+Enter keeps the box open");
  talk.composer.handlers.submit({}, cx);
  await settle();
  assert.equal(talk.target, null);
  await answerIn(talk, "TWO", "Run them first.");
  assert.ok(texts(talk.render(cx)).includes("Run them first."));
});

await test("an answered thread ends with a Reply box that opens the reply under it", async () => {
  const key = `t${threadOf(talk, "TWO").id}`;
  assert.ok(texts(talk.render(cx)).includes("Reply…"));
  diffList(talk.render(cx)).handlers.item_click(key, cx);
  const list = diffList(talk.render(cx));
  assert.equal(list.keys[list.keys.indexOf(key) + 1], "compose", "the reply box opens right under the thread");
  assert.ok(!texts(talk.render(cx)).includes("Reply…"), "the thread being answered hides its Reply box");
  talk.closeComposer();
});

await test("every line has a comment icon: a speech bubble in the accent colour on a line with a thread, a new-comment icon on the others", async () => {
  const icons = walk(diffList(talk.render(cx))).filter((n) => n.kind === "svg" && /message-square(-plus)?\.svg$/.test(n.props.path[0]));
  assert.equal(icons.length, talk.rows.filter((r) => ["+", "-", " "].includes(r.kind)).length);
  assert.ok(icons.every((n) => n.props.text_color?.[0] === "#accent"), "each icon has its own colour: a hover colour never reaches a child");
  assert.equal(icons.filter((n) => n.props.path[0].endsWith("message-square.svg")).length, 2, "TWO and zero have threads");
});

const lineRows = (tree) => walk(diffList(tree)).filter((n) => typeof n.id === "string" && n.id.startsWith("line-") && !n.id.endsWith("-new"));

await test("on a line without a thread, the new-comment icon shows wherever the pointer is on the line", async () => {
  for (const layout of ["unified", "split"]) {
    H.shared["git-changes.layout"] = layout;
    const open = lineRows(talk.render(cx)).filter((line) => !line.kids.some((k) => k.props?.path?.[0]?.endsWith("message-square.svg")));
    assert.ok(open.length >= 1, `${layout}: some lines have no thread`);
    for (const line of open) {
      const layer = line.kids.find((k) => k.id === `${line.id}-new`);
      assert.ok(layer, `${layout}: ${line.id} has a new-comment layer`);
      assert.ok(layer.props.absolute && layer.props.inset_0, "the layer covers the whole line");
      assert.deepEqual([layer.props.opacity, layer.hoverStyle.props.opacity], [[0], [1]], "the layer is invisible until the pointer is on it");
    }
  }
  H.shared["git-changes.layout"] = "unified";
});

await test("hovering anywhere on a line lights up only its line numbers, the text beside them keeps its colour", async () => {
  for (const layout of ["unified", "split"]) {
    H.shared["git-changes.layout"] = layout;
    const lines = lineRows(talk.render(cx));
    assert.ok(lines.length >= 3, `${layout}: every line reacts to the pointer`);
    assert.equal(new Set(lines.map((n) => n.id)).size, lines.length, `${layout}: each line has its own id, so its hover follows the pointer, not only a scroll`);
    for (const line of lines) {
      assert.equal(line.hoverStyle.props.bg[0], "#accent33", `${layout}: the hover lights up the line's own background`);
      assert.ok(line.kids.some((k) => k.props?.bg?.[0] === "#backgr"), `${layout}: the text covers it with an opaque background of its own`);
    }
  }
  H.shared["git-changes.layout"] = "unified";
});

await test("a long answer makes its thread taller, wrapped at the card's width", async () => {
  const { wrappedLines } = await import(pathToFileURL(join(lib, "comments.js")).href);
  assert.equal(wrappedLines("aaaaa bbbbb ccccc", 11), 2);
  assert.equal(wrappedLines("a".repeat(25), 10), 3);
  assert.equal(wrappedLines("a\nb", 10), 2);
  const list = diffList(talk.render(cx)), at = list.keys.indexOf(lineKey(talk, "TWO")) + 1;
  talk.bodyWidth = 300; talk.imageVersion++;
  const narrow = diffList(talk.render(cx));
  assert.ok(narrow.sizes[at] > list.sizes[at], `${narrow.sizes[at]} > ${list.sizes[at]}`);
});

await test("in a linked worktree, the session comes from the main checkout, where Claude Code started", async () => {
  const worktree = join(base, "talk-worktree");
  talkGit("worktree", "add", "-q", worktree, "-b", "review");
  writeFileSync(join(worktree, "notes.ts"), "one\nTwo\nthree\n");
  const view = await openTalk(worktree);
  await comment(view, lineKey(view, "Two"), "Title case?");
  const call = runs().at(-1);
  assert.equal(call[call.indexOf("--cwd") + 1], talkRepo);
  assert.equal(claudeOf(call)[2], MAIN_SESSION);
});

await test("a Claude Code terminal in the diff's space is the session forked, and the copy is its sub-agent", async () => {
  const elsewhere = join(base, "elsewhere"), own = "44444444-4444-4444-8444-444444444444";
  mkdirSync(elsewhere);
  addSession(projectOf(elsewhere), own, 3600);
  const saved = H.panes;
  H.panes = [...saved, { pane: "p9", tab: "tb1", terminal: "t9", cwd: elsewhere, app: "claude-code", title: "✳ Review MR 2149", focused: false }];
  try {
    const view = await openTalk();
    await comment(view, lineKey(view, "one"), "Keep this?");
    const call = runs().at(-1), opt = (name) => call[call.indexOf(name) + 1];
    assert.deepEqual([opt("--parent"), opt("--cwd"), claudeOf(call)[2]], ["t9", elsewhere, own]);
  } finally { H.panes = saved; }
});

await test("a GitHub remote adds optional PRs and Issues tabs, CI status chip, and a full PR detail view", async () => {
  const forgeRepo = join(base, "forge-repo");
  mkdirSync(forgeRepo);
  const fgit = (...a) => execFileSync("git", a, { cwd: forgeRepo, env, encoding: "utf8" });
  fgit("init", "-q", "-b", "main");
  fgit("remote", "add", "origin", "git@github.com:daniell0gda/herdr-git-changes.git");
  writeFileSync(join(forgeRepo, "a.js"), "export const x = 1;\n");
  fgit("add", "."); fgit("commit", "-qm", "init");

  const savedExec = H.exec, savedFocused = H.focused, savedProps = H.currentProps;
  const ghCalls = [];
  H.exec = async (cmd, args, opts) => {
    if (cmd === "gh") {
      ghCalls.push(args);
      if (args[0] === "run") return { code: 0, stdout: JSON.stringify([{ workflowName: "CI", status: "completed", conclusion: "success", url: "https://github.com/daniell0gda/herdr-git-changes/actions/runs/1" }]), stderr: "" };
      if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify([{ number: 3, title: "Multi-provider comments", state: "OPEN", isDraft: false, author: { login: "alice" }, assignees: [{ login: "bob" }], reviewRequests: [{ login: "carol" }], headRefName: "feat/providers", baseRefName: "main", statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }], comments: [{ body: "nice" }], url: "https://github.com/daniell0gda/herdr-git-changes/pull/3" }]), stderr: "" };
      if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ number: 3, title: "Multi-provider comments", body: "## Why\nSupport all CLIs", state: "OPEN", isDraft: false, author: { login: "alice" }, assignees: [{ login: "bob" }], reviewRequests: [{ login: "carol" }], reviews: [{ author: { login: "dave" }, state: "APPROVED" }], labels: [{ name: "feat" }], headRefName: "feat/providers", baseRefName: "main", statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }], comments: [{ author: { login: "bob" }, body: "LGTM", createdAt: "2026-01-01T10:00:00Z" }], files: [{ path: "mods/git-changes/comments.js", additions: 40, deletions: 5 }], url: "https://github.com/daniell0gda/herdr-git-changes/pull/3" }), stderr: "" };
      if (args[0] === "api" && args[1]?.includes("/check-runs")) return { code: 0, stdout: JSON.stringify({ check_runs: [{ id: 55, name: "CI / test", status: "completed", conclusion: "success", html_url: "https://github.com/daniell0gda/herdr-git-changes/actions/runs/1/job/55" }] }), stderr: "" };
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify([{ user: { login: "carol" }, body: "Great idea", path: "mods/git-changes/comments.js", line: 12, created_at: "2026-01-01T11:00:00Z" }]), stderr: "" };
      if (args[0] === "issue" && args[1] === "list") return { code: 0, stdout: JSON.stringify([{ number: 5, title: "Add forge tabs", state: "OPEN", author: { login: "alice" }, assignees: [{ login: "alice" }], labels: [{ name: "enhancement" }], comments: [], url: "https://github.com/daniell0gda/herdr-git-changes/issues/5" }]), stderr: "" };
      return { code: 0, stdout: "[]", stderr: "" };
    }
    return savedExec(cmd, args, opts);
  };
  H.currentProps = { folder: forgeRepo };
  try {
    const p = new Panel(); p.init(cx); await settle();
    const initial = p.render(cx);
    assert.ok(byId(initial, "tab-reviews") && byId(initial, "tab-issues"), "GitHub remote reveals PRs and Issues tabs");
    assert.ok(byId(initial, "gc-ci-chip"), "CI status chip shows in the branch row");
    assert.ok(!ghCalls.some((a) => a[0] === "pr" || a[0] === "issue"), "PRs and Issues are not fetched until their tab opens");

    byId(initial, "tab-reviews").handlers.click({}, cx);
    await settle();
    const prTree = p.render(cx);
    assert.ok(texts(prTree).includes("Multi-provider comments"), "PR list renders lazily on tab click");
    byId(prTree, "forge-review-3").handlers.click({}, cx);
    await settle();

    H.currentProps = { role: "forge", space: "sp1" };
    const fv = new ForgeView(); fv.init(cx); await settle();
    const detailText = texts(fv.render(cx)).join("\n");
    assert.ok(detailText.includes("#3 Multi-provider comments") && detailText.includes("@bob") && detailText.includes("@dave (approved)") && detailText.includes("mods/git-changes/comments.js:12"), detailText);

    p.toggleForgeTabs(cx);
    assert.ok(!byId(p.render(cx), "tab-reviews"), "users can hide forge tabs if they want pure git");
    p.toggleForgeTabs(cx);
  } finally {
    H.exec = savedExec; H.focused = savedFocused; H.currentProps = savedProps;
    localStorage.setItem("forgeTabs", "1"); localStorage.setItem("tab", "changes");
  }
});

await test("switching the comment provider lets any Herdr-supported AI CLI answer diff threads", async () => {
  const { commentProviders, terminalAnswerAfter } = await import(pathToFileURL(join(lib, "comments.js")).href);
  const filtered = commentProviders([
    { key: "claude", name: "Claude Code", run: ["claude"], installed: true, agent: true },
    { key: "codex", name: "Codex", run: ["codex", "--no-daemon"], installed: true, agent: true },
    { key: "antigravity", name: "Antigravity", run: ["agy"], installed: true, agent: true },
    { key: "cursor", name: "Cursor", run: ["agent"], installed: true, agent: true },
    { key: "hermes", name: "Hermes", run: ["hermes"], installed: true, agent: true },
    { key: "grok", name: "Grok", run: ["grok"], installed: false, agent: true },
    { key: "herdr-web-browser", name: "Browser", run: ["herdr-web-browser"], installed: true, agent: true },
  ]);
  assert.deepEqual(filtered.map((p) => p.key), ["claude", "codex", "antigravity", "cursor", "hermes"]);
  assert.equal(terminalAnswerAfter("\x1b[32m> Why?\nBecause it is clearer.\n>\x1b[0m", "", "Why?"), "Because it is clearer.");
  assert.equal(terminalAnswerAfter("old output\nFollow up?\nUpdated it.\n❯ ", "old output\n", "Follow up?"), "Updated it.");

  const savedKnown = H.knownAgents, savedScreens = H.terminalScreens;
  H.knownAgents = async () => [
    { key: "claude", name: "Claude Code", run: ["claude"], installed: true, agent: true },
    { key: "antigravity", name: "Antigravity", run: ["agy"], installed: true, agent: true },
    { key: "codex", name: "Codex", run: ["codex", "--no-daemon"], installed: true, agent: true },
    { key: "cursor", name: "Cursor", run: ["agent"], installed: true, agent: true },
    { key: "hermes", name: "Hermes", run: ["hermes"], installed: true, agent: true },
  ];
  H.terminalScreens = {};
  try {
    const altRepo = join(base, "alt-provider");
    mkdirSync(altRepo);
    const altGit = (...a) => execFileSync("git", a, { cwd: altRepo, env, encoding: "utf8" });
    altGit("init", "-q", "-b", "main");
    writeFileSync(join(altRepo, "notes.ts"), "const a = 1;\n");
    altGit("add", "."); altGit("commit", "-qm", "init");
    writeFileSync(join(altRepo, "notes.ts"), "const a = 2;\n");

    const view = await openTalk(altRepo);
    byId(view.render(cx), "gc-diff-provider").handlers.click({}, cx);
    chooseMenu(H.overlays.at(-1), "Antigravity");
    view.render(cx); await settle();
    assert.ok(texts(view.render(cx)).includes("Antigravity"), "header reflects selected provider");

    diffList(view.render(cx)).handlers.item_click(lineKey(view, "const a = 2;"), cx);
    assert.ok(texts(view.render(cx)).includes("↩ ask Antigravity · ⇧↩ new line · Esc cancel"));
    view.composer.set_value("Should this be in English?");
    view.composer.handlers.submit({}, cx);
    await settle();

    const call = runs().at(-1), c = threadOf(view, "const a = 2;");
    assert.deepEqual(claudeOf(call), ["agy"], "runs the selected Herdr agent argv");
    const sent = hcCalls.at(-1);
    assert.equal(sent[0], "send");
    assert.equal(sent[1], c.terminal);
    assert.ok(sent[2].includes("My comment: Should this be in English?"));

    H.terminalScreens[c.terminal] = `My comment: Should this be in English?\nYes, translate it to English.\n❯ `;
    terminalOf(c).status = "idle";
    view.pollAnswers(cx); await settle();
    const rendered = texts(view.render(cx));
    assert.ok(rendered.includes("Antigravity") && rendered.includes("Yes, translate it to English."));

    await comment(view, threadKeys(view)[0], "Please do it.");
    assert.deepEqual(hcCalls.at(-1), ["send", c.terminal, "Please do it."]);
    H.terminalScreens[c.terminal] += "\nPlease do it.\nDone, translated.\n❯ ";
    terminalOf(c).status = "idle";
    view.pollAnswers(cx); await settle();
    assert.ok(texts(view.render(cx)).includes("Done, translated."));
  } finally {
    H.knownAgents = savedKnown;
    H.terminalScreens = savedScreens;
    delete H.shared["git-changes.commentProvider"];
  }
});
await test("a thread keeps the agent it started with when another one is selected later", async () => {
  const { providerKeyOf } = await import(pathToFileURL(join(lib, "comments.js")).href);
  assert.equal(providerKeyOf({ session: "abc" }, "codex"), "claude", "a Claude Code thread stays with Claude Code");
  assert.equal(providerKeyOf({ provider: "codex", terminal: "t1" }, "cursor"), "codex", "another agent's thread stays with it");
  assert.equal(providerKeyOf({}, "cursor"), "cursor", "a thread not yet asked takes the selected agent");
});
rmSync(base, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
clearInterval(keepAlive);
process.exit(process.exitCode ?? 0);
