// The panel, laid out like Zed's git panel: Changes, Repo and History tabs; a
// toolbar with View Diff, the tree/flat and one/two-column switches, and
// Stage All; the files grouped Conflicts, Tracked, Untracked, as a folder tree
// or a flat list, each with a staging checkbox, then the stashes; and at the
// bottom the branch with its remote button, the commit message, the Commit
// button and the last commit. Whatever you pick opens in the main area, in
// one diff tab per space (diff.js).
// Menus are popups of this same mod (menu.js); what's picked comes back
// through the shared "git-changes.pick" and runs here.
//
// Started as `herdr-app do mod.clone '{"name":"changes"}'` of Herdr's shipped
// Changes panel (Apache-2.0): location(), the folder watch and the context-keyed
// refresh are still its. Listens to herdr-git-graph's "git-graph.changed" so
// both panels refresh after either acts.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, notify, shared, setShared, openOverlay, run, props, nextCommand, window as appWindow } from "herdr";
import * as G from "./git.js";
import * as Apps from "./apps.js";
import * as AI from "./aimsg.js";
import { icon, menuHeight } from "./menu.js";
import { showInTab, shownIn, shownSource, getLayout, setLayout } from "./diff.js";
import { History } from "./history.js";
import { ROW, OUTER, START, PAD, INDENT, BOX, ACTION, COUNT, COUNT_GAP, BRANCH, FOLDABLE, buildRows, buildBranchRows, filesInside, matchingPath, isFolded, stepIndex, zoneAt } from "./rows.js";

// The focused terminal's folder, or `props.folder` when opened as a pane on one repository.
function location() {
  const fixed = props()?.folder;
  if (fixed) return { cwd: fixed, on: props()?.on ?? null };
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  // The diff tab is a mod pane with no folder: keep showing the repository it shows.
  if (pane?.mod === "git-changes") {
    const shown = shownSource(space?.id);
    if (shown) return { cwd: shown.root, on: shown.on ?? null };
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const itemKey = (it) => (it ? `${it.area}:${it.ref ?? it.hash ?? it.path ?? ""}` : "");
const repoRowKey = (shown) => (shown?.area === "base-file" ? `file:${shown.path}` : null);
const historyRowKey = (shown) => (shown?.area === "all" ? G.UNCOMMITTED : shown?.area === "commit" ? shown.hash : null);
const MOVES = { up: -1, down: 1 };
const FOLDS = { left: true, right: false };
const KEYBOARD_BACK_MS = 150;
const plain = (it) => JSON.parse(JSON.stringify(it));
const ROW_VIEWS = { section: "sectionRowView", folder: "folderRowView", file: "fileRowView", stash: "stashRowView" };
const ROW_ACTIONS = { section: "sectionAction", folder: "folderAction", file: "fileAction", stash: "stashAction" };
const FILE_OPENERS = { linux: "xdg-open", macos: "open", windows: "explorer" };
const OPEN_TIMEOUT = 10000;
const baseName = (path) => path.split("/").filter(Boolean).pop() ?? path;
const isTimeout = (e) => /time/i.test(String(e?.message ?? e));
const sumOf = (entries, field) => entries.reduce((n, e) => n + e[field], 0);
const failedRead = (error, base = null) => ({ base, error, entries: [], signature: error });

/** The branches HEAD may have started from, each with its distance to HEAD; counted one by one before git 2.41. */
async function baseCandidates(git) {
  const counted = await git(G.baseRefsArgs(true));
  if (counted.code === 0) return G.parseBaseRefs(counted.stdout);
  const plain = await git(G.baseRefsArgs(false));
  if (plain.code !== 0) return [];
  return Promise.all(G.parseBaseRefs(plain.stdout).map(async (base) => {
    const r = await git(G.aheadBehindArgs(base.ref));
    const [ahead, behind] = r.code === 0 ? G.parseAheadBehind(r.stdout) : [NaN, NaN];
    return { ...base, ahead, behind };
  }));
}

/** What the Repo tab lists: every file the branch's commits changed since it left its base, or why there's nothing to compare. */
async function readBranchFiles(git, status) {
  const head = status.branch.oid;
  if (!head) return failedRead("No commits yet");
  const base = G.nearestBase(await baseCandidates(git), status.branch.head);
  if (!base) return failedRead("No main, master, develop or release branch to compare with");
  const found = await git(G.mergeBaseArgs(base));
  if (found.code !== 0) return failedRead(`No commit in common with ${base}`, base);
  const mergeBase = found.stdout.trim();
  const [names, stats] = await Promise.all([git(G.baseNameStatusArgs(mergeBase, head)), git(G.baseNumstatArgs(mergeBase, head))]);
  if (names.code !== 0) throw new Error(G.gitError(names));
  const numstat = stats.code === 0 ? stats.stdout : "", entries = G.branchEntries(names.stdout, numstat);
  return { base, mergeBase, head, entries: entries.slice(0, G.LIMIT), limited: entries.length > G.LIMIT,
    signature: [base, mergeBase, head, names.stdout, numstat].join("\x1f") };
}

export class Panel {
  init(cx) {
    this.uid = `gc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.listId = `gc-rows-${Math.random().toString(36).slice(2)}`;
    this.repoListId = `gc-repo-${Math.random().toString(36).slice(2)}`;
    this.changesScroll = VirtualListScrollHandle.new(); this.repoScroll = VirtualListScrollHandle.new();
    this.cursor = {};
    this.repo = null; this.repoModel = null;
    this.model = null; this.press = null; this.signature = null;
    this.entries = []; this.stashes = []; this.remotes = []; this.last = null;
    this.history = new History(); this.panelWidth = 400;
    this.branch = null;
    this.listMode = localStorage.getItem("list") === "flat" ? "flat" : "tree";
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.tab = props()?.tab ?? localStorage.getItem("tab") ?? "changes";
    this.collapsed = JSON.parse(localStorage.getItem("collapsed") ?? "{}");
    this.signoff = localStorage.getItem("signoff") === "1";
    try { this.ai = AI.normalizeAi(JSON.parse(localStorage.getItem("ai") ?? "null")); } catch { this.ai = AI.normalizeAi(null); }
    this.aiBusy = false;
    this.message = ""; this.menuActions = {}; this.menuSerial = 0;
    this.pickSeen = shared("git-changes.pick")?.at; this.seenChange = shared("git-graph.changed");
    this.handle = cx.focus_handle();
    this.editor = TextareaState.new({ placeholder: "" });
    this.editor.set_auto_grow(3, 10);
    this.editor.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.editor.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.editor.on("submit", (e, cx) => { if (e.secondary) this.commit(cx, false); });
    this.editor.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.editor.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.filter = "";
    this.filterBox = InputState.new({ placeholder: "Filter files" });
    this.filterBox.on("change", (_e, cx) => this.setFilter(this.filterBox.value(), cx));
    this.filterBox.on("focus", (_e, cx) => { this.filtering = true; cx.notify(); });
    this.filterBox.on("blur", (_e, cx) => { this.filtering = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => { for (;;) { if (await nextCommand() === "focus") this.handle.focus(); cx.notify(); } });
  }

  // --- reading ----------------------------------------------------------------

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  reset() {
    this.menuActions = {}; this.armed = null;
    this.root = null; this.branch = null; this.entries = []; this.stashes = []; this.last = null; this.history.clear();
    this.limited = false; this.model = null; this.signature = null; this.press = null;
    this.repo = null; this.repoModel = null;
  }

  /** Keeps the Repo tab's new read; false when it's the same as the last one. */
  takeRepo(next) {
    if (next.signature === this.repo?.signature) return false;
    this.repo = next; this.repoModel = null;
    return true;
  }

  refresh(cx) {
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.contextVersion = (this.contextVersion ?? 0) + 1; this.reset();
      this.message = ""; this.editor.set_value(""); this.amend = false;
      this.error = null; this.note = null; this.watched = null;
    }
    if (this.loading || this.busy) { this.again = true; return; }
    if (!cwd) return;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      let changed = true;
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.reset(); this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...G.READ, ...args], { cwd: root, on });
        const status = await git(G.STATUS);
        if (status.code !== 0) throw new Error(G.gitError(status));
        const s = G.parseStatus(status.stdout), hasHead = Boolean(s.branch.oid);
        const [stats, stash, remote, last] = await Promise.all([
          hasHead ? git(["diff", "HEAD", ...G.NUMSTAT]).then((r) => [r]) : Promise.all([git(["diff", "--cached", ...G.NUMSTAT]), git(["diff", ...G.NUMSTAT])]),
          git(G.STASHES), git(["remote"]),
          hasHead ? git(G.historyArgs({ all: false, limit: 1 })) : null]);
        if (key() !== context) return;
        // The graph is read only while it shows; switching to it reads it.
        const historyMoved = this.tab === "history" && await this.history.read(git, { changes: s.entries.length, head: s.branch.oid, upstream: s.branch.upstream });
        if (key() !== context) return;
        const repoRead = this.tab === "repo" ? await readBranchFiles(git, s) : null;
        if (key() !== context) return;
        const repoMoved = Boolean(repoRead) && this.takeRepo(repoRead);
        const signature = [status.stdout, ...stats.map((r) => r.stdout), stash.stdout, remote.stdout, last?.stdout ?? "", Math.floor(Date.now() / 60000)].join("\x1f");
        if (!historyMoved && !repoMoved && signature === this.signature && this.root === root && !this.error) { changed = false; return; }
        this.signature = signature;
        const numstat = G.parseNumstat(...stats.filter((r) => r.code === 0).map((r) => r.stdout));
        this.entries = s.entries.slice(0, G.LIMIT).map((e) => ({ ...e, area: "file", add: 0, del: 0, ...(numstat[e.path] ?? {}) }));
        this.limited = s.entries.length > G.LIMIT;
        this.model = null;
        this.root = root; this.on = on; this.branch = s.branch; this.hasHead = hasHead;
        this.stashes = stash.code === 0 ? G.parseStashes(stash.stdout).map((x) => ({ ...x, area: "stash" })) : [];
        this.remotes = remote.code === 0 ? remote.stdout.split("\n").filter(Boolean) : [];
        this.last = last?.code === 0 ? G.parseLog(last.stdout).map((c) => ({ ...c, area: "commit" }))[0] ?? null : null;
        this.error = null;
        this.watch(root, cx);
      } catch (e) { if (key() === context) this.error = String(e?.message ?? e); }
      finally {
        this.loading = false; if (changed) cx.notify();
        if (this.again) this.refresh(cx);
      }
    });
  }

  // What the space's diff tab shows now, when it's this repository.
  shown() { return this.root ? shownIn(spaces().find((sp) => sp.active)?.id, this.root) : null; }

  rowsModel() {
    if (!this.model) this.model = buildRows({ entries: matchingPath(this.entries, this.filter), stashes: this.stashes, listMode: this.listMode, folded: this.folded, collapsed: this.collapsed });
    return this.model;
  }

  repoRowsModel() {
    if (!this.repoModel) this.repoModel = buildBranchRows({ entries: matchingPath(this.repo?.entries ?? [], this.filter), listMode: this.listMode, folded: this.folded });
    return this.repoModel;
  }

  setFilter(text, cx) {
    if (text === this.filter) return;
    this.filter = text; this.model = null; this.repoModel = null;
    cx.notify();
  }

  clearFilter(cx) { this.filterBox.set_value(""); this.setFilter("", cx); }

  pickBranch(fields, cx) {
    this.pick({ ...fields, base: this.repo.mergeBase, head: this.repo.head, baseName: this.repo.base }, cx);
  }

  // Show it in the main area: one diff tab per space, reused and renamed.
  pick(item, cx) {
    const space = spaces().find((sp) => sp.active);
    if (!space || !this.root) return;
    this.note = null;
    showInTab(space.id, item, { root: this.root, on: this.on ?? null });
    this.keepKeyboard(cx);
    cx.notify();
  }

  setTab(tab, cx) {
    if (this.tab === tab) return;
    this.tab = tab; localStorage.setItem("tab", tab);
    this.refresh(cx); cx.notify();
  }

  // --- acting -----------------------------------------------------------------

  // Runs git commands in order, stopping at the first failure. `what` names the
  // work for the busy label and errors; remote work always toasts.
  act(cx, what, cmds, { done, remote, after } = {}) {
    if (!this.root || this.busy || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, version = this.contextVersion;
    this.busy = what; this.note = null; this.armed = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of cmds) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error(G.gitError(r));
        }
        if (this.contextVersion === version && key() === context) after?.();
        if (done) notify({ title: done, level: "success", timeout: 3000 });
      } catch (e) {
        const message = String(e?.message ?? e);
        if (this.contextVersion === version && key() === context) this.note = `${what} failed: ${message}`;
        if (remote) notify({ title: `${what} failed`, body: message, level: "error" });
      } finally {
        this.busy = null;
        setShared("git-graph.changed", Date.now());
        this.refresh(cx); cx.notify();
      }
    });
    cx.notify();
  }

  fail(cx, message) { this.note = message; cx.notify(); }
  clearMessage() { this.message = ""; this.editor.set_value(""); this.amend = false; }
  mode() { return G.commitMode(this.entries); }
  suggestion() { return G.suggestMessage(this.entries); }

  setAi(patch, cx) {
    this.ai = AI.normalizeAi({ ...this.ai, ...patch });
    localStorage.setItem("ai", JSON.stringify(this.ai));
    cx.notify();
  }

  // Asks the chosen agent's CLI for a message from the staged diff (or every tracked
  // change when nothing is staged) and drops it into the box. Never commits.
  generateMessage(cx) {
    if (this.aiBusy || this.busy || this.loading || !this.root) return;
    const mode = this.mode();
    if (mode !== "staged" && mode !== "tracked") return this.fail(cx, "Stage the files to describe first");
    const root = this.root, on = this.on, context = this.context, version = this.contextVersion, hasHead = this.hasHead, ai = this.ai;
    const current = () => this.contextVersion === version && key() === context;
    this.aiBusy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const diff = await exec("git", [...G.READ, ...AI.diffArgs(mode, hasHead)], { cwd: root, on });
        if (diff.code !== 0) throw new Error(G.gitError(diff));
        if (!diff.stdout.trim()) throw new Error("No changes to describe");
        const log = hasHead ? await exec("git", [...G.READ, "log", "-5", "--format=%s"], { cwd: root, on }).catch(() => null) : null;
        const prompt = AI.buildPrompt(diff.stdout, { recent: log?.code === 0 ? log.stdout.trim() : "" });
        const r = await exec(AI.AGENTS[ai.agent].command, AI.agentArgs(ai, prompt), { cwd: root, on, timeout: 120000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || `${ai.agent} exited ${r.code}`);
        const text = AI.cleanMessage(r.stdout);
        if (!text) throw new Error(`${AI.AGENTS[ai.agent].label} returned nothing`);
        if (current() && !this.message.trim()) { this.message = text; this.editor.set_value(text); }
        else if (current()) notify({ title: "Generated message (box not empty, not applied)", body: text, level: "info", timeout: 8000 });
      } catch (e) {
        if (current()) this.note = `Generate message failed: ${String(e?.message ?? e)}`;
      } finally {
        this.aiBusy = false; cx.notify();
      }
    });
    cx.notify();
  }

  aiMenu(cx) {
    const a = AI.AGENTS[this.ai.agent];
    this.menu([
      ...Object.entries(AI.AGENTS).map(([id, v]) => ({ label: v.label, check: this.ai.agent === id, run: (cx) => this.setAi({ agent: id, model: AI.AGENTS[id].models[0], effort: "" }, cx) })),
      { separator: true },
      ...a.models.map((m) => ({ label: `Model: ${m || "default"}`, check: this.ai.model === m, run: (cx) => this.setAi({ model: m }, cx) })),
      { separator: true },
      ...a.efforts.map((e) => ({ label: `Effort: ${e || "default"}`, check: this.ai.effort === e, run: (cx) => this.setAi({ effort: e }, cx) })),
    ], cx);
  }

  commit(cx, push) {
    if (this.busy || this.loading) return;
    const message = this.message.trim() || (this.amend ? "" : this.suggestion());
    const c = G.commitArgs({ message, amend: this.amend, signoff: this.signoff, mode: this.mode() });
    if (c.error) return this.fail(cx, c.error);
    let cmds = c.cmds;
    if (push) {
      // An amended commit that was already pushed needs a lease to replace it.
      const p = G.pushArgs(this.branch ?? {}, this.remotes, { force: this.amend && Boolean(this.branch?.upstream) && this.branch.ahead === 0 });
      if (p.error) return this.fail(cx, p.error);
      cmds = [...cmds, ...p.cmds];
    }
    const label = this.amend ? "Amend" : "Commit";
    this.act(cx, push ? `${label} & push` : label, cmds, { remote: push, done: push ? `Committed and pushed ${this.branch.head}` : null, after: () => this.clearMessage() });
  }

  remote(cx, type, opts = {}) {
    const b = this.branch ?? {};
    if (type === "fetch") return this.act(cx, "Fetch", G.fetchArgs(), { remote: true, done: "Fetched" });
    if (type === "pull") {
      const p = G.pullArgs(b, opts);
      if (p.error) return this.fail(cx, p.error);
      return this.act(cx, "Pull", p.cmds, { remote: true, done: `Pulled ${b.upstream}` });
    }
    const p = G.pushArgs(b, this.remotes, opts);
    if (p.error) return this.fail(cx, p.error);
    this.act(cx, opts.force ? "Force push" : "Push", p.cmds, { remote: true, done: `Pushed ${b.head}${p.remote ? ` to ${p.remote}` : ""}` });
  }

  stash(cx, staged) {
    if (staged ? !this.entries.some((e) => e.staged !== "none") : !this.entries.length) return this.fail(cx, staged ? "Nothing staged to stash" : "Nothing to stash");
    this.act(cx, "Stash", G.stashPushArgs(this.message, { staged }), { after: () => this.clearMessage() });
  }

  uncommit(cx) {
    if (!this.last) return;
    const subject = this.last.subject;
    this.act(cx, "Uncommit", G.uncommitArgs(this.last.parents.length > 0), {
      after: () => { if (!this.message.trim()) { this.message = subject; this.editor.set_value(subject); } } });
  }

  toggleAmend(cx) {
    if (this.busy) return;
    this.amend = !this.amend;
    if (this.amend && !this.message.trim() && this.last) {
      // The whole last message, body too.
      const root = this.root, on = this.on, context = this.context, version = this.contextVersion;
      cx.spawn(async (cx) => {
        const r = await exec("git", [...G.READ, "log", "-1", "--format=%B"], { cwd: root, on });
        if (this.contextVersion === version && key() === context && r.code === 0 && this.amend && !this.message.trim()) { this.message = r.stdout.trim(); this.editor.set_value(this.message); }
        cx.notify();
      });
    }
    cx.notify();
  }

  // The section checkbox: all staged unstages them, else stages them all.
  toggleSection(list, cx) {
    const paths = list.map((e) => e.path);
    if (!paths.length) return;
    const all = list.every((e) => e.staged === "all");
    this.act(cx, all ? "Unstage" : "Stage", [all ? (this.hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-q", "-r", "--", ...paths]) : ["add", "-A", "--", ...paths]]);
  }

  setListMode(mode, cx) { this.listMode = mode; this.model = null; this.repoModel = null; localStorage.setItem("list", mode); cx.notify(); }
  fold(key, cx) {
    if (this.folded.has(key)) this.folded.delete(key); else this.folded.add(key);
    this.model = null; this.repoModel = null;
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }
  collapseSection(area, cx) {
    this.collapsed[area] = !this.collapsed[area]; this.model = null;
    localStorage.setItem("collapsed", JSON.stringify(this.collapsed));
    cx.notify();
  }

  // Inline destructive buttons ask on the button itself: the first click arms it, the second runs it.
  arm(id, cx, then) {
    if (this.armed === id) { this.armed = null; then(); return; }
    this.armed = id;
    cx.timer.after(3000, (cx) => { if (this.armed === id) { this.armed = null; cx.notify(); } });
    cx.notify();
  }

  // --- menus ------------------------------------------------------------------

  menu(items, cx, width = 250) {
    if (!this.root || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context;
    const actions = this.menuActions = {}, serial = ++this.menuSerial;
    const out = items.filter(Boolean).map((it, i) => {
      if (it.separator) return { separator: true };
      // IDs never repeat in this panel, even when an old popup delivers late.
      const id = `m${serial}-${i}`;
      if (it.run) actions[id] = (cx) => {
        // Check at execution, not just receipt: takePick schedules another task.
        if (this.menuActions !== actions || this.root !== root || this.on !== on || this.context !== context || key() !== context) return;
        this.menuActions = {};
        it.run(cx);
      };
      const { run: _r, ...rest } = it;
      return { ...rest, id };
    }).filter((it, i, a) => !(it.separator && (i === 0 || i === a.length - 1 || a[i - 1].separator)));
    openOverlay({ mod: "git-changes", kind: "popup", at: "pointer", width, height: menuHeight(out), props: { role: "menu", owner: this.uid, items: out } });
    cx.notify();
  }

  takePick(cx) {
    const pick = shared("git-changes.pick");
    if (!pick || pick.owner !== this.uid || pick.at === this.pickSeen) return;
    this.pickSeen = pick.at;
    const fn = this.menuActions[pick.id];
    if (fn) cx.spawn(async (cx) => { fn(cx); cx.notify(); });
  }

  fileMenu(e, cx) {
    const staged = e.staged === "all";
    this.menu([
      { label: staged ? "Unstage" : e.conflict ? "Mark resolved" : "Stage", icon: staged ? "minus" : "plus", run: (cx) => this.act(cx, staged ? "Unstage" : "Stage", G.toggleArgs(e, this.hasHead)) },
      { label: "Show diff", icon: "diff", run: (cx) => this.pick(e, cx) },
      this.openWithItem(e),
      { separator: true },
      ...this.folderItems(e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : ""),
      { separator: true },
      { label: "Copy path", icon: "copy", copy: e.path },
      { label: "Copy full path", icon: "copy", copy: `${this.root}/${e.path}` },
      { separator: true },
      { label: e.untracked ? "Trash file" : "Discard changes", icon: e.untracked ? "trash" : "undo", danger: true, run: (cx) => this.act(cx, "Discard", G.discardArgs(e, this.hasHead)) },
    ], cx);
  }

  folderMenu(row, cx) {
    const staged = row.staged === "all";
    this.menu([
      { label: staged ? "Unstage folder" : "Stage folder", icon: staged ? "minus" : "plus", run: (cx) => this.toggleSection(filesInside(row), cx) },
      { separator: true },
      ...this.folderItems(row.path),
      { separator: true },
      { label: "Copy path", icon: "copy", copy: row.path },
      { label: "Copy full path", icon: "copy", copy: `${this.root}/${row.path}` },
    ], cx);
  }

  folderItems(relative) {
    const dir = relative ? `${this.root}/${relative}` : this.root, local = !this.on;
    return [
      { label: "Open folder", icon: "folder", hint: local ? "" : "this computer only", disabled: !local, run: (cx) => this.openFolder(dir, cx) },
      { label: "Open in terminal", icon: "folder", run: () => this.openInTerminal(dir) },
    ];
  }

  openWithItem(e) {
    const hint = this.on ? "this computer only" : appWindow().platform !== "linux" ? "Linux only" : "";
    return { label: "Open with…", icon: "file", hint, disabled: Boolean(hint) || e.status === "D", run: (cx) => this.openWith(`${this.root}/${e.path}`, cx) };
  }

  openWith(file, cx) {
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        const apps = await Apps.applicationsFor(file);
        if (this.context !== context) return;
        if (!apps.length) return this.fail(cx, "No application opens this file");
        this.menu(apps.map((app) => ({ label: app.name, icon: "file", hint: app.isDefault ? "default" : "", run: (cx) => this.launch(app, file, cx) })), cx);
      } catch (e) {
        if (this.context === context) this.fail(cx, `Open with failed: ${String(e?.message ?? e)}`);
      }
    });
  }

  launch(app, file, cx) {
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await Apps.launch(app, file, (ms) => cx.sleep(ms)); } catch (e) {
        if (!isTimeout(e) && this.context === context) this.fail(cx, `Open with ${app.name} failed: ${String(e?.message ?? e)}`);
      }
    });
  }

  openFolder(dir, cx) {
    const platform = appWindow().platform, opener = FILE_OPENERS[platform], context = this.context;
    if (!opener || this.on) return this.fail(cx, "Open folder works on this computer only");
    cx.spawn(async (cx) => {
      try {
        const r = await exec(opener, [dir], { timeout: OPEN_TIMEOUT });
        if (r.code !== 0 && platform !== "windows") throw new Error(G.gitError(r));
      } catch (e) {
        if (isTimeout(e) || this.context !== context) return;
        this.note = `Open folder failed: ${String(e?.message ?? e)}`; cx.notify();
      }
    });
  }

  openInTerminal(dir) {
    const space = spaces().find((sp) => sp.active);
    run("tab.new", { ...(space ? { space: space.id } : {}), folder: dir, name: baseName(dir) });
  }

  stashMenu(s, cx) {
    this.menu([
      { label: "Apply", icon: "check", hint: "keep", run: (cx) => this.act(cx, "Apply stash", G.stashArgs("apply", s.ref)) },
      { label: "Pop", icon: "fetch", hint: "apply & drop", run: (cx) => this.act(cx, "Pop stash", G.stashArgs("pop", s.ref)) },
      { label: "Show diff", icon: "diff", run: (cx) => this.pick(s, cx) },
      { separator: true },
      { label: "Drop", icon: "trash", danger: true, run: (cx) => this.act(cx, "Drop stash", G.stashArgs("drop", s.ref)) },
    ], cx);
  }

  commitMenu(c, cx) {
    const head = this.last && c.hash === this.last.hash, current = this.branch?.head;
    const refs = c.refs ?? [], local = refs.filter((r) => r.kind === "branch" && r.name !== current);
    const remote = refs.filter((r) => r.kind === "remote" && !refs.some((b) => b.kind === "branch" && r.name.endsWith(`/${b.name}`)));
    this.menu([
      ...local.map((r) => ({ label: `Checkout ${r.name}`, icon: "branch", run: (cx) => this.act(cx, "Checkout", G.checkoutArgs(r.name), { done: `Switched to ${r.name}` }) })),
      ...remote.map((r) => ({ label: `Checkout ${r.name}`, icon: "cloud", hint: "track", run: (cx) => this.act(cx, "Checkout", G.checkoutRemoteArgs(r.name), { done: `Tracking ${r.name}` }) })),
      !head && { label: "Checkout this commit", icon: "commit", hint: "detached", run: (cx) => this.act(cx, "Checkout", G.detachArgs(c.hash), { done: `Checked out ${c.short}` }) },
      { separator: true },
      { label: "Show diff", icon: "diff", run: (cx) => this.pick(c, cx) },
      { label: "Copy hash", icon: "copy", hint: "⌘C", copy: c.hash },
      { label: "Copy short hash", icon: "copy", hint: c.short, copy: c.short },
      { label: "Copy message", icon: "copy", copy: c.subject },
      { separator: true },
      head && { label: "Uncommit", icon: "undo", hint: "keep changes staged", run: (cx) => this.uncommit(cx) },
      { label: "Revert commit", icon: "reset", run: (cx) => this.act(cx, "Revert", G.revertArgs(c.hash), { done: `Reverted ${c.short}` }) },
    ], cx, 270);
  }

  optionsMenu(cx) {
    const any = this.entries.length > 0, tracked = this.entries.some((e) => !e.untracked), untracked = this.entries.some((e) => e.untracked);
    this.menu([
      { label: "Stage all", icon: "plus", disabled: !any, run: (cx) => this.act(cx, "Stage", G.stageAllArgs()) },
      { label: "Unstage all", icon: "minus", disabled: !this.entries.some((e) => e.staged !== "none"), run: (cx) => this.act(cx, "Unstage", G.unstageAllArgs(this.hasHead)) },
      { separator: true },
      { label: "Stash all", icon: "stash", disabled: !any, run: (cx) => this.stash(cx, false) },
      { label: "Stash staged", icon: "stash", disabled: !this.entries.some((e) => e.staged !== "none"), run: (cx) => this.stash(cx, true) },
      { label: "Pop latest stash", icon: "fetch", disabled: !this.stashes.length, run: (cx) => this.act(cx, "Pop stash", G.stashArgs("pop", "stash@{0}")) },
      { separator: true },
      { label: "Discard tracked changes", icon: "undo", danger: true, disabled: !tracked, run: (cx) => this.act(cx, "Discard", G.discardTrackedArgs(this.hasHead)) },
      { label: "Trash untracked files", icon: "trash", danger: true, disabled: !untracked, run: (cx) => this.act(cx, "Trash", G.trashUntrackedArgs()) },
    ], cx);
  }

  remoteMenu(cx) {
    const b = this.branch ?? {}, has = this.remotes.length > 0, onBranch = !b.detached && Boolean(b.head);
    this.menu([
      { label: "Fetch", icon: "refresh", disabled: !has, run: (cx) => this.remote(cx, "fetch") },
      { label: "Pull", icon: "fetch", hint: b.behind ? `↓${b.behind}` : "", disabled: !b.upstream, run: (cx) => this.remote(cx, "pull") },
      { label: "Pull (rebase)", icon: "fetch", disabled: !b.upstream, run: (cx) => this.remote(cx, "pull", { rebase: true }) },
      { separator: true },
      { label: b.upstream ? "Push" : "Publish branch", icon: "push", hint: b.ahead ? `↑${b.ahead}` : "", disabled: !has || !onBranch, run: (cx) => this.remote(cx, "push") },
      { label: "Force push (with lease)", icon: "push", danger: true, disabled: !has || !onBranch, run: (cx) => this.remote(cx, "push", { force: true }) },
    ], cx);
  }

  commitOptions(cx) {
    const remote = this.remotes.length > 0 && this.branch && !this.branch.detached;
    this.menu([
      { label: "Amend last commit", check: Boolean(this.amend), disabled: !this.last, run: (cx) => this.toggleAmend(cx) },
      { label: "Signoff", check: this.signoff, run: () => { this.signoff = !this.signoff; localStorage.setItem("signoff", this.signoff ? "1" : "0"); } },
      { separator: true },
      { label: this.amend ? "Amend & push" : "Commit & push", icon: "push", disabled: !remote, run: (cx) => this.commit(cx, true) },
      { label: "Stash all", icon: "stash", disabled: !this.entries.length, run: (cx) => this.stash(cx, false) },
      { separator: true },
      { label: "Uncommit last commit", icon: "undo", hint: "keep changes", disabled: !this.last, run: (cx) => this.uncommit(cx) },
    ], cx);
  }

  branchMenu(cx) {
    if (!this.root) return;
    const root = this.root, on = this.on, current = this.branch?.head;
    cx.spawn(async (cx) => {
      const r = await exec("git", [...G.READ, ...G.BRANCHES], { cwd: root, on });
      const names = r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
      this.menu([
        ...names.map((n) => ({ label: n, check: n === current, run: (cx) => n !== current && this.act(cx, "Switch branch", G.checkoutArgs(n), { done: `Switched to ${n}` }) })),
        { separator: true },
        current && { label: "Copy branch name", icon: "copy", copy: current },
      ], cx, 280);
    });
  }

  // --- keyboard ---------------------------------------------------------------

  changesKeys() {
    const { rows, byKey } = this.rowsModel();
    return { tab: "changes", rows, byKey, scroll: this.changesScroll, keyOf: itemKey,
      open: (row, cx) => this[ROW_ACTIONS[row.type]](row, "body", cx) };
  }

  repoKeys() {
    const { rows, byKey } = this.repoRowsModel();
    return { tab: "repo", rows, byKey, scroll: this.repoScroll, keyOf: repoRowKey,
      open: (row, cx) => this.repoRowClicked(row.key, cx) };
  }

  historyKeys() {
    const h = this.history;
    return { tab: "history", rows: h.commits.map((c) => ({ key: c.hash, type: "commit" })), byKey: h.index, scroll: h.scroll,
      keyOf: historyRowKey, open: (row, cx) => this.pickCommit(h.find(row.key), 1, cx) };
  }

  keyboardList() {
    if (this.tab === "history") return this.historyKeys();
    return this.tab === "repo" ? this.repoKeys() : this.changesKeys();
  }

  /** The highlighted row: the last one clicked or reached by the keyboard, until the diff tab shows something else; then the row the diff tab shows. */
  selectedKey(list, shownItem = this.shown()) {
    const shown = list.keyOf(shownItem), cursor = this.cursor[list.tab];
    return cursor?.shown === shown && list.byKey.has(cursor.key) ? cursor.key : shown;
  }

  remember(list, key) { this.cursor[list.tab] = { key, shown: list.keyOf(this.shown()) }; }

  /** None while the message box has the keyboard; only ↑ and ↓ while the filter has it, so ← → move its caret. */
  listTakes(keystroke) { return !this.typing && (!this.filtering || keystroke in MOVES); }

  /** Handles ↑ ↓ (select the row above or below), ← → (fold or unfold a group or folder) and ↩ (open the row); false for any other key. */
  navigate(key, cx) {
    if (!(key in MOVES || key in FOLDS || key === "enter")) return false;
    const list = this.keyboardList();
    if (!this.root || !list.rows.length) return false;
    const at = list.rows.findIndex((r) => r.key === this.selectedKey(list)), row = list.rows[at];
    if (key in MOVES) this.moveTo(list, stepIndex(at, MOVES[key], list.rows.length), cx);
    else if (key === "enter" || (FOLDABLE.has(row?.type) && isFolded(row) !== FOLDS[key])) this.openRow(list, row, cx);
    return true;
  }

  /** Selects the row at `index` and scrolls to it; a file, stash or commit also opens in the diff tab. */
  moveTo(list, index, cx) {
    const row = list.rows[index];
    if (FOLDABLE.has(row.type)) this.remember(list, row.key);
    else this.openRow(list, row, cx);
    list.scroll.scroll_to_item(index);
    cx.notify();
  }

  /** Takes the keyboard back from the diff tab, which takes it when it opens or is selected. */
  keepKeyboard(cx) {
    this.handle.focus();
    cx.timer.after(KEYBOARD_BACK_MS, () => this.handle.focus());
  }

  openRow(list, row, cx) {
    if (!row) return;
    list.open(row, cx);
    this.remember(list, row.key);
    cx.notify();
  }

  // --- drawing ----------------------------------------------------------------

  iconButton(id, name, tip, onClick, t, { danger, disabled, label, active, size = 22 } = {}) {
    const armed = this.armed === id;
    return h_flex().id(id).h(size).min_w(size).px(label || armed ? 6 : 4).gap(4).flex_none().items_center().justify_center().rounded(5)
      .text_color(disabled ? t.dim : armed || danger ? t.ansi1 : t.muted).text_size(12).tooltip(tip)
      .when(armed, (e) => e.bg(t.ansi1 + "22")).when(Boolean(active) && !disabled, (e) => e.bg(t.selected).text_color(t.accent))
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(danger || armed ? t.ansi1 : t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) onClick(cx); })
      .child(svg(icon(name)).size(13).flex_none())
      .when(Boolean(label || armed), (e) => e.child(armed ? "Sure?" : label));
  }

  // Connected icon toggles: one cell per choice, the chosen one highlighted.
  pills(id, choices, value, onPick, t) {
    return h_flex().p(2).gap(2).flex_none().rounded(7).border_1().border_color(t.border).children(choices.map(([v, name, tip]) =>
      h_flex().id(`${id}-${v}`).size(20).items_center().justify_center().rounded(5).cursor_pointer().tooltip(tip)
        .text_color(value === v ? t.accent : t.muted).when(value === v, (e) => e.bg(t.selected)).hover((s) => s.bg(value === v ? t.selected : t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); if (value !== v) onPick(v, cx); })
        .child(svg(icon(name)).size(12))));
  }

  // A button with a dropdown half, like Zed's "Push ⌄" and "Commit ⌄".
  split(id, text, t, { primary, enabled, onClick, onMenu, tip, iconName }) {
    const fg = !enabled ? t.dim : primary ? t.solid_foreground : t.foreground, bg = primary && enabled ? t.solid : t.raised;
    return h_flex().id(id).h(26).flex_none().items_center().rounded(6).border_1().border_color(primary && enabled ? t.solid : t.border).bg(bg).text_color(fg).text_size(12)
      .child(h_flex().id(`${id}-main`).h_full().px(10).gap(5).items_center().rounded_l(6).tooltip(tip)
        .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(primary ? t.solid : t.hover).opacity(0.88)))
        .on_click((_e, cx) => { if (enabled) onClick(cx); })
        .when(Boolean(iconName), (e) => e.child(svg(icon(iconName)).size(12).flex_none()))
        .child(text))
      .child(div().w(1).h(14).bg(primary && enabled ? t.solid_foreground + "44" : t.border))
      .child(h_flex().id(`${id}-menu`).h_full().px(5).items_center().rounded_r(6).cursor_pointer().hover((s) => s.bg(primary && enabled ? t.solid : t.hover).opacity(0.88))
        .on_click((_e, cx) => onMenu(cx))
        .child(svg(icon("chevron-down")).size(12).text_color(primary && enabled ? t.solid_foreground : t.muted)));
  }

  checkboxView(id, state, t) {
    const on = state === "all", some = state === "some";
    return h_flex().id(id).size(BOX).flex_none().items_center().justify_center().rounded(3).border_1()
      .border_color(on || some ? t.accent : t.input).when(on, (e) => e.bg(t.accent)).text_size(10).text_color(on ? t.accent_foreground : t.accent)
      .hover((s) => s.border_color(t.accent))
      .child(on ? "✓" : some ? "−" : "");
  }

  actionIcon(id, name, tip, t, { danger, armed } = {}) {
    return h_flex().id(id).size(ACTION).flex_none().items_center().justify_center().rounded(5).tooltip(armed ? "Click again to confirm" : tip)
      .text_color(armed ? t.ansi1 : t.dim).when(armed, (e) => e.bg(t.ansi1 + "22"))
      .hover((s) => s.bg(t.hover).text_color(danger || armed ? t.ansi1 : t.foreground))
      .child(svg(icon(name)).size(13).flex_none());
  }

  rowBody(key, t, { selected = false, gap = 8, depth = 0, tip } = {}) {
    return h_flex().id(`in-${key}`).flex_1().min_w(0).h_full().pl(START + depth * INDENT).pr(PAD).gap(gap).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(selected ? t.accent : t.background + "00").when(selected, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .when(Boolean(tip), (el) => el.tooltip(tip));
  }

  sectionRowView(row, t, selected) {
    return this.rowBody(row.key, t, { selected, gap: COUNT_GAP })
      .child(svg(icon(row.folded ? "chevron-right" : "chevron-down")).size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().text_size(12).text_color(t.muted).child(row.title))
      .when(row.area !== "stash", (e) => e.child(this.checkboxView(`check-${row.area}`, row.staged, t)))
      .child(div().w(COUNT).flex_none().px(4).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).text_center().child(String(row.count)));
  }

  folderRowView(row, t, selected) {
    return this.rowBody(row.key, t, { selected, gap: 6, depth: row.depth, tip: row.path })
      .when(row.area !== BRANCH, (el) => el.child(this.checkboxView(`stage-dir-${row.key}`, row.staged, t)))
      .child(svg(icon(row.open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim))
      .child(svg(icon("folder")).size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(row.name))
      .when(!row.open, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(row.files))));
  }

  fileRowView(row, t, selected) {
    const e = row.entry, armed = this.armed === `discard-${e.path}`, staging = row.area !== BRANCH;
    const color = e.conflict || e.status === "D" ? t.ansi1 : e.untracked || e.status === "A" ? t.ansi2 : t.blocked;
    return this.rowBody(row.key, t, { selected, depth: row.depth, tip: e.path })
      .when(staging, (el) => el.child(this.checkboxView(`stage-${e.path}`, e.staged, t)))
      .child(div().w(10).flex_none().text_size(11).text_color(color).child(e.untracked ? "U" : e.status))
      .child(h_flex().flex_1().min_w(0).items_center()
        .child(div().max_w(240).min_w(0).truncate().text_color(e.status === "D" ? t.muted : t.foreground).when(e.status === "D", (el) => el.line_through()).child(row.name))
        .when(this.listMode === "flat", (el) => el.child(div().pl(6).min_w(0).flex_1().truncate().text_size(11).text_color(t.dim).child(row.dir))))
      .when(armed, (el) => el.child(div().text_size(11).text_color(t.ansi1).child("Sure?")))
      .when(!armed && !e.untracked, (el) => el
        .child(div().text_size(11).text_color(t.ansi2).child(`+${e.add}`))
        .child(div().text_size(11).text_color(t.ansi1).child(`−${e.del}`)))
      .when(staging, (el) => el.child(this.actionIcon(`discard-${e.path}`, e.untracked ? "trash" : "undo", e.untracked ? "Trash file" : "Discard changes", t, { danger: true, armed })));
  }

  stashRowView(row, t, selected) {
    const s = row.stash;
    return this.rowBody(row.key, t, { selected })
      .child(svg(icon("stash")).size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child(s.subject || s.ref))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(s.when))
      .child(this.actionIcon(`apply-${s.ref}`, "check", "Apply (keep the stash)", t))
      .child(this.actionIcon(`pop-${s.ref}`, "fetch", "Pop (apply and drop)", t))
      .child(this.actionIcon(`drop-${s.ref}`, "trash", "Drop", t, { danger: true, armed: this.armed === `drop-${s.ref}` }));
  }

  listRow(row, t, selectedKey, height) {
    return h_flex().id(`row-${row.key}`).w_full().h(height).flex_none().px(OUTER)
      .child(this[ROW_VIEWS[row.type]](row, t, row.key === selectedKey));
  }

  pressed(e) {
    this.press = e.local_position && e.bounds ? { x: e.local_position.x, width: e.bounds.width } : null;
  }

  rowClicked(key, cx) {
    const row = this.rowsModel().byKey.get(key), press = this.press, zoom = settings().zoom ?? 1;
    this.press = null;
    if (!row) return;
    this[ROW_ACTIONS[row.type]](row, press ? zoneAt(row, press.x / zoom, press.width / zoom) : "body", cx);
    this.remember(this.changesKeys(), key);
  }

  sectionAction(row, zone, cx) {
    if (zone === "stage") this.toggleSection(row.list, cx); else this.collapseSection(row.area, cx);
  }

  folderAction(row, zone, cx) {
    if (zone === "stage") this.toggleSection(filesInside(row), cx); else this.fold(`${row.area}:${row.path}`, cx);
  }

  fileAction(row, zone, cx) {
    const e = row.entry;
    if (zone === "stage") this.act(cx, e.staged === "all" ? "Unstage" : "Stage", G.toggleArgs(e, this.hasHead));
    else if (zone === "discard") this.arm(`discard-${e.path}`, cx, () => this.act(cx, "Discard", G.discardArgs(e, this.hasHead)));
    else this.pick(e, cx);
  }

  stashAction(row, zone, cx) {
    const ref = row.stash.ref;
    if (zone === "apply") this.act(cx, "Apply stash", G.stashArgs("apply", ref));
    else if (zone === "pop") this.act(cx, "Pop stash", G.stashArgs("pop", ref));
    else if (zone === "drop") this.arm(`drop-${ref}`, cx, () => this.act(cx, "Drop stash", G.stashArgs("drop", ref)));
    else this.pick(row.stash, cx);
  }

  rowMenu(key, cx) {
    const row = this.rowsModel().byKey.get(key);
    if (row?.type === "file") this.fileMenu(row.entry, cx);
    else if (row?.type === "folder") this.folderMenu(row, cx);
    else if (row?.type === "stash") this.stashMenu(row.stash, cx);
  }

  fileList(t, selectedKey) {
    const { rows } = this.rowsModel(), zoom = settings().zoom ?? 1;
    const rowPx = Math.max(1, Math.round(ROW * zoom)), height = rowPx / zoom;
    return div().id("git-changes-rows").flex_1().min_h(0).relative().py(4)
      .on_mouse_down("left", (e) => this.pressed(e))
      .child(v_virtual_list(this.listId, rows.length, rowPx, (i) => rows[i].key,
        (range) => rows.slice(range.start, range.end).map((row) => this.listRow(row, t, selectedKey, height)))
        .on_item_click((key, cx) => this.rowClicked(key, cx))
        .on_item_secondary_click((key, _e, cx) => this.rowMenu(key, cx))
        .track_scroll(this.changesScroll)
        .size_full())
      .child(Scrollbar.vertical(this.listId).viewport_from_layout().absolute().inset_0());
  }

  repoRowClicked(key, cx) {
    const row = this.repoRowsModel().byKey.get(key);
    if (row?.type === "folder") this.fold(`${BRANCH}:${row.path}`, cx);
    else if (row?.type === "file") this.pickBranch({ ...row.entry, area: "base-file" }, cx);
    if (row) this.remember(this.repoKeys(), key);
  }

  repoRowMenu(key, cx) {
    const row = this.repoRowsModel().byKey.get(key);
    if (!row) return;
    const path = row.type === "file" ? row.entry.path : row.path;
    const folder = row.type === "file" ? row.dir : row.path;
    this.menu([
      row.type === "file" && { label: "Show diff", icon: "diff", run: (cx) => this.repoRowClicked(key, cx) },
      row.type === "file" && this.openWithItem(row.entry),
      { separator: true },
      ...this.folderItems(folder),
      { separator: true },
      { label: "Copy path", icon: "copy", copy: path },
      { label: "Copy full path", icon: "copy", copy: `${this.root}/${path}` },
    ], cx);
  }

  repoList(t, selectedKey) {
    const { rows } = this.repoRowsModel(), zoom = settings().zoom ?? 1;
    const rowPx = Math.max(1, Math.round(ROW * zoom)), height = rowPx / zoom;
    return div().id("git-changes-repo-rows").flex_1().min_h(0).relative().py(4)
      .child(v_virtual_list(this.repoListId, rows.length, rowPx, (i) => rows[i].key,
        (range) => rows.slice(range.start, range.end).map((row) => this.listRow(row, t, selectedKey, height)))
        .on_item_click((key, cx) => this.repoRowClicked(key, cx))
        .on_item_secondary_click((key, _e, cx) => this.repoRowMenu(key, cx))
        .track_scroll(this.repoScroll)
        .size_full())
      .child(Scrollbar.vertical(this.repoListId).viewport_from_layout().absolute().inset_0());
  }

  repoView(t, shown) {
    const view = v_flex().id("git-changes-repo").flex_1().min_h(0), notice = (text) => view.child(div().p(12).text_color(t.dim).child(text));
    if (!this.repo) return notice("Loading the branch's changes…");
    if (this.repo.error) return notice(this.repo.error);
    if (!this.repo.entries.length) return notice(`No commits since ${this.repo.base}`);
    if (!this.repoRowsModel().rows.length) return notice(this.noMatchText());
    return view.child(this.repoList(t, this.selectedKey(this.repoKeys(), shown)));
  }

  noMatchText() { return `No files match “${this.filter.trim()}”`; }

  filterBar(t) {
    return h_flex().id("filter").h(26).flex_none().mx(8).my(6).pl(8).pr(2).gap(6).items_center().rounded(6).border_1()
      .border_color(this.filtering ? t.accent : t.border).bg(t.background).cursor_text()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.filterBox.focus(); })
      .child(svg(icon("search")).size(12).flex_none().text_color(this.filtering ? t.accent : t.dim))
      .child(Input.new(this.filterBox).flex_1().min_w(0).text_size(12).text_color(t.foreground))
      .when(Boolean(this.filter), (e) => e.child(this.iconButton("clear-filter", "x", "Clear the filter · Esc", (cx) => this.clearFilter(cx), t, { size: 20 })));
  }

  emptyNotice(t) {
    return v_flex().flex_none().py(18).gap(4).items_center().text_color(t.dim)
      .child(div().child("No changes to commit"))
      .when(this.branch?.ahead > 0, (e) => e.child(div().text_size(11).child(`${this.branch.ahead} commit${this.branch.ahead > 1 ? "s" : ""} to push`)));
  }

  changesView(t, shown) {
    const list = v_flex().id("git-changes-list").flex_1().min_h(0);
    if (!this.root) return list.p(6).child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : "No folder")));
    const unmatched = this.entries.length > 0 && !matchingPath(this.entries, this.filter).length;
    return list.when(this.entries.length === 0, (e) => e.child(this.emptyNotice(t)))
      .when(unmatched, (e) => e.child(div().p(12).text_color(t.dim).child(this.noMatchText())))
      .when(this.rowsModel().rows.length > 0, (e) => e.child(this.fileList(t, this.selectedKey(this.changesKeys(), shown))));
  }

  // A row of the graph picked: the uncommitted row shows every change.
  pickCommit(c, _clicks, cx) { this.pick(c.uncommitted ? { area: "all" } : c, cx); }

  historyView(t, shown) {
    return this.history.view(t, {
      selected: this.selectedKey(this.historyKeys(), shown),
      panelWidth: this.panelWidth, loading: this.loading,
      onPick: (c, clicks, cx) => { this.pickCommit(c, clicks, cx); this.remember(this.historyKeys(), c.hash); },
      onMenu: (c, cx) => (c.uncommitted ? this.optionsMenu(cx) : this.commitMenu(c, cx)),
      onMore: (cx) => { this.history.more(); this.refresh(cx); cx.notify(); },
    });
  }

  tabs(t) {
    const tab = (id, label) => div().id(`tab-${id}`).flex_1().h_full().flex().items_center().justify_center().cursor_pointer().text_size(13)
      .text_color(this.tab === id ? t.foreground : t.muted).when(this.tab === id, (e) => e.border_b(2).border_color(t.accent)).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.setTab(id, cx)).child(label);
    return h_flex().h(34).flex_none().border_b(1).border_color(t.border)
      .child(tab("changes", this.entries.length ? `Changes (${this.entries.length})` : "Changes"))
      .child(tab("repo", "Repo"))
      .child(tab("history", "History"));
  }

  lineCounts(entries, t) {
    return h_flex().pl(4).gap(4).items_center().text_size(11)
      .child(div().text_color(t.ansi2).child(`+${sumOf(entries, "add")}`))
      .child(div().text_color(t.ansi1).child(`−${sumOf(entries, "del")}`));
  }

  viewSwitches(t) {
    return [
      this.pills("list", [["tree", "list-tree", "Folder tree"], ["flat", "list", "Flat list"]], this.listMode, (m, cx) => this.setListMode(m, cx), t),
      this.pills("layout", [["unified", "rows", "Diff in one column"], ["split", "columns", "Diff in two columns: before | after"]], getLayout(), (m, cx) => { setLayout(m); cx.notify(); }, t),
    ];
  }

  repoToolbar(t) {
    const repo = this.repo, entries = repo?.entries ?? [], any = entries.length > 0 && Boolean(repo.mergeBase);
    return h_flex().h(32).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(this.iconButton("view-diff-base", "diff", repo?.base ? `Show every change since ${repo.base} in the main area` : "Show every change of the branch",
        (cx) => this.pickBranch({ area: "base" }, cx), t, { label: "View Diff", disabled: !any }))
      .when(any, (e) => e.child(this.lineCounts(entries, t)))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(repo?.base ? `${entries.length} since ${repo.base}` : ""))
      .children(this.viewSwitches(t))
      .child(this.iconButton("refresh-repo", "refresh", "Refresh", (cx) => this.refresh(cx), t, { disabled: Boolean(this.busy) }));
  }

  toolbar(t) {
    const busy = Boolean(this.busy), any = this.entries.length > 0, allStaged = any && this.entries.every((e) => e.staged === "all");
    if (this.tab === "repo") return this.repoToolbar(t);
    if (this.tab === "history") {
      const h = this.history, n = h.base.length;
      const segment = (id, text, on, all) => div().id(id).h(20).px(8).flex().items_center().rounded(5).text_size(11.5).cursor_pointer()
        .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.raised).border_1().border_color(t.border))
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { if (!on) { h.setAll(all); this.refresh(cx); cx.notify(); } }).child(text);
      return h_flex().h(32).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .child(segment("history-all", "All branches", h.all, true)).child(segment("history-current", "Current", !h.all, false)))
        .child(this.iconButton("history-remotes", "cloud", h.remotes ? "Showing every remote branch: click to show only the upstream" : "Showing only the upstream: click to show every remote branch",
          (cx) => { h.setRemotes(!h.remotes); this.refresh(cx); cx.notify(); }, t, { active: h.remotes, disabled: !h.all }))
        .child(div().flex_1().text_right().text_size(11).text_color(t.dim).child(n ? `${n}${h.hasMore ? "+" : ""}` : ""))
        .child(this.iconButton("refresh-h", "refresh", "Refresh", (cx) => this.refresh(cx), t, { disabled: busy }));
    }
    return h_flex().h(32).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(this.iconButton("view-diff", "diff", "Show every change in the main area", (cx) => this.pick({ area: "all" }, cx), t, { label: "View Diff", disabled: !any }))
      .when(any, (e) => e.child(this.lineCounts(this.entries, t)))
      .child(div().flex_1())
      .children(this.viewSwitches(t))
      .child(this.iconButton("options", "sliders", "More", (cx) => this.optionsMenu(cx), t))
      .child(this.iconButton("stage-all", allStaged ? "minus" : "plus", allStaged ? "Unstage everything" : "Stage everything",
        (cx) => this.act(cx, allStaged ? "Unstage" : "Stage", allStaged ? G.unstageAllArgs(this.hasHead) : G.stageAllArgs()), t, { label: allStaged ? "Unstage All" : "Stage All", disabled: busy || !any }));
  }

  branchRow(t) {
    const b = this.branch, busy = Boolean(this.busy), action = G.remoteAction(b, this.remotes, this.hasHead);
    const name = b.detached ? `detached ${b.oid?.slice(0, 7) ?? ""}` : b.head;
    return h_flex().h(34).flex_none().px(10).gap(6).items_center()
      .child(h_flex().id("branch").min_w(0).flex_1().gap(5).items_center().cursor_pointer().text_size(12).tooltip(b.upstream ? `Tracking ${b.upstream}` : "No upstream")
        .on_click((_e, cx) => this.branchMenu(cx))
        .child(svg(icon("branch")).size(13).flex_none().text_color(t.muted))
        .child(div().flex_none().text_color(t.muted).child(this.root.split("/").pop()))
        .child(div().flex_none().text_color(t.dim).child("/"))
        .child(div().min_w(0).truncate().hover((s) => s.text_color(t.accent)).child(name))
        .child(svg(icon("chevron-down")).size(11).flex_none().text_color(t.dim)))
      .when(Boolean(action), (e) => e.child(this.split("remote", busy && /Push|Pull|Fetch/.test(this.busy) ? `${this.busy}…` : action.count ? `${action.count} ${action.label}` : action.label, t, {
        enabled: !busy, iconName: action.count ? null : action.type === "pull" ? "fetch" : action.type === "push" ? "push" : "refresh",
        tip: action.type === "push" ? (b.upstream ? `Push to ${b.upstream}` : "Push and set upstream") : action.type === "pull" ? `Pull ${b.upstream} (fast-forward only)` : "Fetch from every remote",
        onClick: (cx) => this.remote(cx, action.type), onMenu: (cx) => this.remoteMenu(cx),
      })));
  }

  editorBox(t) {
    const hint = this.amend ? "" : this.suggestion();
    return div().id("commit-editor").relative().mx(10).min_h(70).px(10).py(8).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).bg(t.background).cursor_text()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.editor.focus(); })
      .when(!this.message, (e) => e.child(div().absolute().top(8).left(10).right(10).truncate().text_size(12).text_color(t.dim)
        .font_family("JetBrains Mono").child(hint || (this.amend ? "Amend message (empty keeps the last one)" : "Enter commit message"))))
      .child(Textarea.new(this.editor).w_full().text_size(12).text_color(t.foreground).font_family("JetBrains Mono"));
  }

  footer(t) {
    const busy = Boolean(this.busy) || this.loading, mode = this.mode();
    const hasMessage = Boolean(this.message.trim() || this.suggestion());
    const canCommit = !busy && (this.amend ? Boolean(this.last) : hasMessage && (mode === "staged" || mode === "tracked"));
    const label = this.busy && /Commit|Amend/.test(this.busy) ? "Committing…" : this.amend ? "Amend" : mode === "tracked" ? "Commit Tracked" : "Commit";
    const tip = this.amend ? "Replace the last commit" : mode === "tracked" ? "Nothing staged: commit every tracked change (git commit -a)" : mode === "conflict" ? "Resolve the conflicts first" : "Commit the staged changes · ⌘↩";
    return v_flex().flex_none().gap(8).pt(2).pb(8)
      .child(this.editorBox(t))
      .child(h_flex().px(10).gap(6).items_center()
        .when(this.amend, (e) => e.child(div().px(6).py(1).rounded(4).bg(t.accent + "22").text_size(11).text_color(t.accent).child("amend")))
        .when(this.signoff, (e) => e.child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child("signoff")))
        .child(div().flex_1())
        .child(this.iconButton("ai-message", "sparkles", `Generate a message with ${AI.AGENTS[this.ai.agent].label}${this.ai.model ? ` (${this.ai.model})` : ""}`, (cx) => this.generateMessage(cx), t, { label: this.aiBusy ? "Writing…" : null, disabled: this.aiBusy || busy || (mode !== "staged" && mode !== "tracked") }))
        .child(this.iconButton("ai-settings", "sliders", "Choose the agent, model and effort for generated messages", (cx) => this.aiMenu(cx), t))
        .child(this.split("commit", label, t, { primary: true, enabled: canCommit, tip, onClick: (cx) => this.commit(cx, false), onMenu: (cx) => this.commitOptions(cx) })));
  }

  // A short hash that copies the full one when clicked, and says so for a moment.
  copyHash(c, cx) {
    cx.write_to_clipboard(c.hash);
    this.copied = c.hash;
    notify({ title: "Copied commit hash", body: c.hash, level: "success", timeout: 2000 });
    cx.timer.after(1500, (cx) => { if (this.copied === c.hash) { this.copied = null; cx.notify(); } });
    cx.notify();
  }

  hashChip(c, t) {
    const done = this.copied === c.hash;
    return h_flex().id(`hash-${c.hash}`).flex_none().h(20).px(5).gap(4).items_center().rounded(5).cursor_pointer()
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(done ? t.ansi2 : t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`Copy ${c.hash}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.copyHash(c, cx); })
      .child(c.short)
      .child(svg(icon(done ? "check" : "copy")).size(11).flex_none());
  }
  lastCommit(t, shownKey) {
    const c = this.last;
    return h_flex().id("last-commit").h(30).flex_none().px(10).gap(6).items_center().border_t(1).border_color(t.border).text_size(12).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(`${c.short} · ${c.author} · ${c.when}`)
      .on_click((_e, cx) => this.pick(c, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.commitMenu(c, cx); })
      .child(this.hashChip(c, t))
      .child(div().flex_1().min_w(0).truncate().text_color(itemKey(c) === shownKey ? t.accent : t.muted).child(c.subject))
      .child(this.iconButton("uncommit", "undo", "Uncommit (keep the changes staged)", (cx) => this.arm("uncommit", cx, () => this.uncommit(cx)), t, { disabled: Boolean(this.busy) }))
      .child(this.iconButton("history", "history", "History", (cx) => this.setTab("history", cx), t));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const changed = shared("git-graph.changed");
    if (changed !== this.seenChange) { this.seenChange = changed; if (!this.busy) this.refresh(cx); }
    this.takePick(cx);
    const t = theme(), shown = this.shown(), shownKey = itemKey(shown);
    const history = this.tab === "history" && Boolean(this.root), repo = this.tab === "repo" && Boolean(this.root);
    const limited = this.tab === "repo" ? Boolean(this.repo?.limited) : this.limited;
    const graph = history && (this.history.commits.length
      ? this.historyView(t, shown)
      : div().flex_1().p(12).text_color(t.dim).child(this.hasHead ? "Loading history…" : "No commits yet"));
    return v_flex().id("git-changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_size_change((size, cx) => {
        const width = Math.round(size.width / (settings().zoom ?? 1));
        if (width !== this.panelWidth) { this.panelWidth = width; cx.notify(); }
      })
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") { this.commit(cx, false); cx.stop_propagation(); }
        // ⌘C on the panel (not while typing) copies the selected commit's hash.
        else if ((e.keystroke === "cmd-c" || e.keystroke === "ctrl-shift-c") && !this.typing && !this.filtering && this.shown()?.area === "commit") { this.copyHash(this.shown(), cx); cx.stop_propagation(); }
        else if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.filtering) { this.filtering = false; this.clearFilter(cx); this.handle.focus(); cx.stop_propagation(); }
        else if (this.listTakes(e.keystroke) && this.navigate(e.keystroke, cx)) cx.stop_propagation();
      })
      .child(this.tabs(t))
      .when(Boolean(this.root), (e) => e.child(this.toolbar(t)))
      .when(Boolean(this.root) && !history, (e) => e.child(this.filterBar(t)))
      .when(history, (e) => e.child(v_flex().flex_1().min_h(0).child(graph)))
      .when(repo, (e) => e.child(this.repoView(t, shown)))
      .when(!history && !repo, (e) => e.child(this.changesView(t, shown)))
      .when(limited, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(`Showing the first ${G.LIMIT.toLocaleString()} files`)))
      .when(Boolean(this.note), (e) => e.child(div().id("note").px(10).py(6).flex_none().border_t(1).border_color(t.border).text_size(11).text_color(t.ansi1).cursor_pointer().tooltip("Click to dismiss")
        .on_click((_e, cx) => { this.note = null; cx.notify(); }).child(this.note)))
      .when(Boolean(this.root && this.branch), (e) => e.child(v_flex().flex_none().border_t(1).border_color(t.border).bg(t.chrome)
        .child(this.branchRow(t))
        .child(this.footer(t))
        .when(Boolean(this.last), (e) => e.child(this.lastCommit(t, shownKey)))));
  }
}
